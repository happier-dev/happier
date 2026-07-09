# Plugin authoring examples

These example packages document the **current** plugin contract used by the CLI runtime.

All examples in this folder are **V2-only** (`schemaVersion: 2`). No V1/compat authoring fixtures remain.

Plugin package topology is **domain-organized**:

- `agent/` is the executable-agent domain (daemon entrypoints, runtime adapters, hook handlers)
- `ui/` is the UI domain (resources and host-rendered descriptor assets)

Notes:

- Executable code runs through `entrypoints.main` and optional `entrypoints.dev`.
- Local development is `happier plugins install --dev /abs/path`; the dev watcher reloads trusted local plugins after edits and rolls back to the last known good version on load failure.

Examples:

- `action-plugin`: declarative action routed to daemon code
- `lifecycle-hook-plugin`: declarative lifecycle hook handler
- `agent-runtime-plugin`: declarative agent-runtime package with daemon runtime adapter handlers
- `ui-descriptor-plugin`: activation-time resource + host-rendered UI descriptor registration
- `reload-helper-plugin`: activation-time action registration plus `onDispose(...)` for the explicit reload loop
- `bundled-first-party`: bundled first-party agent-runtime example with domain topology
- `external-declarative-ui`: external declarative UI descriptor + resource example (no executable entrypoint)

Local authoring loop:

```bash
happier plugins install --dev /absolute/path/to/apps/cli/src/plugins/testkit/fixtures/authoring-examples/action-plugin
happier plugins show examples.action-plugin
happier plugins reload examples.action-plugin
```

- Remote archive and marketplace installs exist, but executable daemon loading still fails closed for `prompt`/`untrusted` sources.
- For agent-runtime coverage beyond the minimal examples here, also see `../sample-package/`.
