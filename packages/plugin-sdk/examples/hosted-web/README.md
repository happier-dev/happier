# Hosted Web Plugin Example

Install with the public local-plugin install flow by pointing Happier at this
directory. The manifest declares a hosted-web surface served from installed
static assets, a sandbox bridge with a nonce-backed host API, and a descriptor
fallback for unavailable hosted-web runtime states.

Manual QA path:

- Install the plugin from this directory.
- Build/copy hosted assets to the declared `hosted-web/panel` folder.
- Open the example surface and verify the iframe receives the sandbox and nonce.
- Verify a host API `ready` message succeeds and the descriptor fallback renders
  when the static asset endpoint is unavailable.

Expected screenshots:

- `plugins-hosted-web-panel.png`
- `plugins-hosted-web-unavailable.png`
