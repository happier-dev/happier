# Basic SDK example

Run this example from the current repository source against the existing
development stack. Set `HAPPIER_API_ENDPOINT` and `HAPPIER_TOKEN` (an API
Token), then invoke the checked-in example:

```sh
HAPPIER_API_ENDPOINT=https://account.example \
HAPPIER_TOKEN='hap_v1_…' \
HAPPIER_ENDPOINT_MODE=server \
HAPPIER_AGENT_ID=codex \
yarn tsx packages/sdk/examples/basic/index.ts
```

Publication remains separately authorized.

For contributed Actions, use `happier.actions.search(...)`, then
`happier.actions.get({ id })`, before passing the qualified id to
`happier.actions.invoke(id, input)`. Here `happier` is the root client for
daemon-local use and the selected machine-bound client for server use; do not
invoke external Actions through an unbound server `account` client. Qualified
ids use the canonical `<pluginId>/actions/<localId>` spelling; do not split the
string manually to reconstruct a plugin identity. The generated raw
`actions.action.spec.get(...)` path remains available.

For a daemon-local endpoint, read the daemon's current HTTP port instead of
assuming a fixed port:

```sh
DAEMON_PORT="$(happier daemon status --json | jq -er '.daemon.httpPort')"
export HAPPIER_API_ENDPOINT="http://127.0.0.1:$DAEMON_PORT"
export HAPPIER_ENDPOINT_MODE=daemon
```

Set `HAPPIER_ENDPOINT_MODE=daemon` for the daemon-local endpoint. The example
then uses the root client, omitting `target` so the daemon executes on its
current machine; it does not call `machines.list()` and does not require
`HAPPIER_MACHINE_ID`.

Set `HAPPIER_ENDPOINT_MODE=server` for an Account-server endpoint. The example
uses the authenticated machine-list bootstrap and auto-selects only when exactly
one active, non-revoked, non-replaced machine is eligible. With no eligible
machine it stops with an error. With several, it prints the candidate ids and
requires `HAPPIER_MACHINE_ID`; it never silently selects the first row. After
selection, the example binds subsequent Actions to that exact id.

Optional environment variables are `HAPPIER_MACHINE_ID`,
`HAPPIER_WORKSPACE_PATH`, and `HAPPIER_AGENT_ID`. They respectively override
the selected Account-server machine, select the spawned workspace, and select
the catalog Agent routing id.
`HAPPIER_AGENT_ID` defaults to `codex`, so the example calls
`sessions.spawn({ agent: 'codex', ... })` without exposing a server id or a
qualified plugin identity. The example spawns a session, waits, consumes one
item from `followTranscript()`, and leaves the async iterator early so its
follow lease is released. It then sends a follow-up, waits again, prints JSON
containing the session id, followed-item count, and up to three 160-character
semantic history rows (`id`, `role`, `kind`, and `text`). It does not print raw
follow payloads or raw transcript rows, then stops the session. If its initial
message is rejected after Session creation, the example stops the committed
Session from `HappierSessionInitialInputError` before reporting that error. The
package also supports bounded execution-run streams through
`client.runs.startStream(...)`; their iterator is cancelled on normal
completion, early return, abort, or `client.close()`.
