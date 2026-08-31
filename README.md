# Litnet Helper Access Server

Render-ready backend для доступа на 7 дней после доната от 50 RUB.

## Endpoints

- `GET /health` - проверка, можно пинговать.
- `POST /api/access/start` - создать код оплаты.
- `POST /api/access/check` - проверить доступ по `clientId`.
- `POST /api/donationalerts/sync` - синхронизировать донаты из DonationAlerts. Вызывать с `Authorization: Bearer CRON_SECRET`.

## Render env

- `DATABASE_URL` - Render Postgres connection string.
- `DONATION_PAGE_URL` - ссылка на страницу DonationAlerts.
- `DONATIONALERTS_ACCESS_TOKEN` - токен DonationAlerts API.
- `CRON_SECRET` - секрет для sync-запросов.
- `ACCESS_PRICE_RUB=50`
- `ACCESS_DAYS=7`

## Важно

Render Free Web Service засыпает после простоя. Для старта можно пинговать `/health` внешним сервисом каждые 5-10 минут.

Free Render Postgres хранит данные только 30 дней. Для production лучше платный Postgres или внешняя база.
