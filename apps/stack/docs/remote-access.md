# Remote access (Tailscale + phone)

Happy relies on “secure context” browser features (WebCrypto). Browsers treat `http://localhost` as a secure context, but **not** `http://<lan-ip>:<port>` or `http://<tailscale-ip>:<port>`.

For remote access (phone, another laptop, etc) you should use **HTTPS**.

The recommended approach is **Tailscale Serve**, which gives you an `https://*.ts.net` URL for your machine that is only accessible inside your tailnet.

## Quickstart

1) Install Tailscale and sign in on your computer.

2) Enable Serve:

```bash
hapsta tailscale enable
hapsta tailscale url
```

3) Open the URL from `hapsta tailscale url` on another device (also signed into Tailscale).

Tip: on iOS, you can “Add to Home Screen” from Safari to use it like an app.

## Automation

If Serve is already configured, `hapsta start` will automatically prefer the `https://*.ts.net` URL for “public” links unless you explicitly set `HAPPIER_STACK_SERVER_URL`.

You can also ask hapsta to enable Serve automatically at boot:

```bash
HAPPIER_STACK_TAILSCALE_SERVE=1 hapsta start
```

Useful knobs:
- `HAPPIER_STACK_TAILSCALE_WAIT_MS`
- `HAPPIER_STACK_TAILSCALE_BIN`

## Using the native Happy mobile app (optional)

The upstream Happy mobile app has an “API Endpoint” setting (developer mode).
Point it at the same HTTPS `*.ts.net` URL to use your local server.

However, the simplest option is usually the **served web UI** (no app updates needed).
