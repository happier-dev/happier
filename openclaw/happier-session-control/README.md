# OpenClaw Plugin: Happier Session Control

This plugin registers the `happier-session-control` skill for OpenClaw via `openclaw.plugin.json`.

## Install

1) Copy this folder:
   - Source: `openclaw/happier-session-control/`
   - Destination: `<OPENCLAW_PLUGINS_DIR>/happier-session-control/`
2) Ensure `openclaw.plugin.json` is at the plugin root.
3) Enable the plugin in OpenClaw and restart the Gateway (OpenClaw requires a restart after plugin changes).
4) Verify the skill loads and that `requires.bins=["happier"]` passes on the host.

## Plugin config → CLI invocation mapping

Precedence (highest wins):

1) Explicit prefix args provided in the tool invocation (if any)
2) Plugin config `happierServerUrl` (+ `happierWebappUrl`) → prefix `--server-url ... --webapp-url ...`
3) Plugin config `happierServer` → prefix `--server <id-or-name>`
4) No prefix flags → use Happier’s active server profile

`happierHomeDir` mapping:

- If set, export `HAPPIER_HOME_DIR=<value>` for the `happier` process.

