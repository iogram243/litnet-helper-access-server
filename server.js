import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';

const {
  PORT = 10000,
  DATABASE_URL,
  DONATIONALERTS_ACCESS_TOKEN,
  DONATION_PAGE_URL,
  CRON_SECRET,
  ACCESS_PRICE_RUB = '50',
  ACCESS_DAYS = '7',
  DONATIONALERTS_DONATIONS_PATH = '/alerts/donations'
} = process.env;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const app = express();
const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

await initDb();

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'litnet-helper-access' });
});

app.post('/api/access/start', async (req, res) => {
  const clientId = normalizeClientId(req.body?.clientId) || createClientId();
  const code = createPaymentCode();

  await query(
    `insert into payment_codes (code, client_id, amount_rub, expires_at)
     values ($1, $2, $3, now() + interval '30 minutes')
     on conflict (code) do nothing`,
    [code, clientId, Number(ACCESS_PRICE_RUB)]
  );

  res.json({
    clientId,
    code,
    amountRub: Number(ACCESS_PRICE_RUB),
    donationPageUrl: DONATION_PAGE_URL || '',
    instruction: `Оплатите ${ACCESS_PRICE_RUB} RUB и укажите код ${code} в сообщении доната.`
  });
});

app.post('/api/access/check', async (req, res) => {
  const clientId = normalizeClientId(req.body?.clientId);
  if (!clientId) return res.status(400).json({ status: 'error', error: 'clientId is required' });

  const row = await one(
    `select access_until from access_grants
     where client_id = $1 and access_until > now()
     order by access_until desc
     limit 1`,
    [clientId]
  );

  res.json({
    status: row ? 'active' : 'expired',
    accessUntil: row?.access_until || null
  });
});

app.post('/api/donationalerts/sync', async (req, res) => {
  if (!CRON_SECRET || req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.sendStatus(401);
  }

  if (!DONATIONALERTS_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'DONATIONALERTS_ACCESS_TOKEN is required' });
  }

  const donations = await fetchDonations();
  const result = await applyDonations(donations);
  res.json(result);
});

app.listen(Number(PORT), () => {
  console.log(`Litnet Helper access server listening on ${PORT}`);
});

async function initDb() {
  await query(`
    create table if not exists payment_codes (
      code text primary key,
      client_id text not null,
      amount_rub numeric not null,
      expires_at timestamptz not null,
      used_at timestamptz
    );

    create table if not exists access_grants (
      client_id text primary key,
      access_until timestamptz not null,
      updated_at timestamptz not null default now()
    );

    create table if not exists processed_donations (
      donation_id text primary key,
      code text,
      amount numeric,
      currency text,
      created_at timestamptz not null default now()
    );
  `);
}

async function fetchDonations() {
  const url = new URL(`https://www.donationalerts.com/api/v1${DONATIONALERTS_DONATIONS_PATH}`);
  url.searchParams.set('limit', '50');

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${DONATIONALERTS_ACCESS_TOKEN}`,
      Accept: 'application/json'
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DonationAlerts API error ${response.status}: ${text}`);
  }

  const payload = await response.json();
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function applyDonations(donations) {
  let checked = 0;
  let activated = 0;

  for (const donation of donations) {
    checked++;

    const donationId = String(donation.id ?? donation.alert_id ?? '');
    if (!donationId) continue;

    const exists = await one('select donation_id from processed_donations where donation_id = $1', [donationId]);
    if (exists) continue;

    const amount = Number(donation.amount ?? donation.amount_main ?? 0);
    const currency = String(donation.currency ?? donation.currency_code ?? 'RUB').toUpperCase();
    const message = String(donation.message ?? donation.username ?? donation.name ?? '');
    const code = extractPaymentCode(message);

    await query(
      `insert into processed_donations (donation_id, code, amount, currency)
       values ($1, $2, $3, $4)
       on conflict (donation_id) do nothing`,
      [donationId, code, amount, currency]
    );

    if (!code || currency !== 'RUB' || amount < Number(ACCESS_PRICE_RUB)) continue;

    const pending = await one(
      `select code, client_id from payment_codes
       where code = $1 and used_at is null and expires_at > now()`,
      [code]
    );
    if (!pending) continue;

    await query(
      `insert into access_grants (client_id, access_until, updated_at)
       values ($1, now() + ($2 || ' days')::interval, now())
       on conflict (client_id) do update
       set access_until = greatest(access_grants.access_until, now()) + ($2 || ' days')::interval,
           updated_at = now()`,
      [pending.client_id, Number(ACCESS_DAYS)]
    );

    await query('update payment_codes set used_at = now() where code = $1', [code]);
    activated++;
  }

  return { checked, activated };
}

async function query(sql, params = []) {
  return pool.query(sql, params);
}

async function one(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0] || null;
}

function createClientId() {
  return `lh_${crypto.randomBytes(16).toString('hex')}`;
}

function createPaymentCode() {
  return `LF-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function extractPaymentCode(text) {
  return String(text || '').match(/\bLF-[A-F0-9]{6}\b/i)?.[0]?.toUpperCase() || '';
}

function normalizeClientId(value) {
  const text = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,80}$/.test(text) ? text : '';
}
