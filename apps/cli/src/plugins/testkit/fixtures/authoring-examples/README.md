# Plugin authoring examples

These example packages document the **current** plugin/plugin contract used by the CLI runtime.

All examples in this folder are **V2-only** (`schemaVersion: 2`). No V1/compat authoring fixtures remain.

Plugin package topology is **domain-organized**:

- `agent/` is the agent/backend-group domain (daemon entrypoints, runtime adapters, hook handlers)
- `ui/` is the UI domain (resources and host-rendered descriptor assets)

Notes:

- Executable code runs only through the daemon target.
- Local development is `happier plugins install /abs/path && happier plugins reload`.

Examples:

- `action-plugin`: declarative action routed to daemon code
- `lifecycle-hook-plugin`: declarative lifecycle hook handler
- `provider-backend-plugin`: declarative provider/backend package with daemon runtime adapter handlers
- `ui-descriptor-plugin`: activation-time resource + host-rendered UI descriptor registration
- `reload-helper-plugin`: activation-time action registration plus `onDispose(...)` for the explicit reload loop
- `bundled-first-party`: bundled first-party provider/backend example with domain topology
- `external-declarative-ui`: external declarative UI descriptor + resource example (no daemon target)

Local authoring loop:

```bash
happier plugins install /absolute/path/to/apps/cli/src/plugins/testkit/fixtures/authoring-examples/action-plugin
happier plugins show examples.action-plugin
happier plugins reload examples.action-plugin
```

- There is no watcher yet.
- Remote archive and marketplace installs exist, but executable daemon loading still fails closed for `prompt`/`untrusted` sources.
- For provider/backend coverage beyond the minimal examples here, also see `../sample-package/`.
