# iPoGo repository mirror Worker

This is an on-demand Cloudflare Worker mirror of `https://ipogo.app/repo`.
It refreshes the repository metadata and the newest iPoGo `.deb` every hour.
Other package files are fetched and cached the first time they are requested.

## Deploy

```sh
npm install
npx wrangler login
npx wrangler secret put REFRESH_TOKEN
npm run deploy
```

Add the deployed Worker URL as the Sileo source, for example:

```text
sileo://source/https://ipogo-repo-mirror.<account>.workers.dev
```

## Refresh now

```sh
curl https://ipogo-repo-mirror.<account>.workers.dev/refresh \
  -H "Authorization: Bearer $REFRESH_TOKEN"
```

`/health` reports the configured upstream. The Worker does not open-proxy arbitrary URLs; it only serves repository paths and `.deb` files.
