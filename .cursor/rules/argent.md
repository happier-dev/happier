---
description: Use Argent only through its on-demand CLI when device or Chromium control is actually needed
alwaysApply: true
---

# Argent CLI-only policy

This machine intentionally does not register Argent as an MCP server. Do not start
`argent mcp`, and do not run `argent init` or `argent update`, because those commands
can re-register Argent in every detected coding client.

Only invoke Argent when the current task genuinely needs iOS, Android, TV, Electron,
or Chromium interaction:

1. Confirm the CLI with `command -v argent` and `argent --version`.
2. Inspect available tools with `argent tools` or `argent tools describe <tool>`.
3. Inspect parameters with `argent run <tool> --help`.
4. Invoke the tool with `argent run <tool> ...`; use `--args '<json>'` for a complete
   JSON payload and `--json` for machine-readable output.
5. When the device work is finished, run `argent server stop` so the shared watcher
   does not remain active for its idle-timeout window.

Installed `argent-*` skills remain useful methodology references. Translate their
bare tool-call language (for example, “call `list-devices`”) to
`argent run list-devices --json`. Ignore any stale instruction that assumes
`mcp__argent__*` tools or ToolSearch schemas are present.

If the CLI is unavailable, report that once and continue without Argent or ask the
user before installing it. Never auto-install or auto-register it.
