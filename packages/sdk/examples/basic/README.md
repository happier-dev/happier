# Basic SDK example

Install the exact candidate tarball and the TypeScript loader in a fresh
consumer directory:

```sh
SDK_TARBALL=/absolute/path/to/happier-dev-sdk-<version>.tgz
npm install --ignore-scripts --no-audit --no-fund "$SDK_TARBALL"
npm install --save-dev --no-audit --no-fund tsx
```

Then set `HAPPIER_API_ENDPOINT` and `HAPPIER_TOKEN` (an API Token) and run
the installed example with Node.js:

```sh
HAPPIER_API_ENDPOINT=https://account.example \
HAPPIER_TOKEN='hap_v1_…' \
HAPPIER_ENDPOINT_MODE=server \
HAPPIER_AGENT_ID=codex \
node --import tsx ./node_modules/@happier-dev/sdk/examples/basic/index.ts
```

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
uses the authenticated machine-list bootstrap to select an active machine, then
binds subsequent Actions to that exact id. `HAPPIER_MACHINE_ID` is an optional
server-mode override when the caller already knows the intended machine.

Optional environment variables are `HAPPIER_MACHINE_ID`,
`HAPPIER_WORKSPACE_PATH`, and `HAPPIER_AGENT_ID`. They respectively override
the selected Account-server machine, select the spawned workspace, and select
the catalog Agent routing id.
`HAPPIER_AGENT_ID` defaults to `codex`, so the example calls
`sessions.spawn({ agent: 'codex', ... })` without exposing a server id or a
qualified plugin identity. The example spawns a session, waits, consumes one
item from `followTranscript()`, and leaves the async iterator early so its
follow lease is released. It then sends a follow-up, waits again, prints JSON
containing the session id and both followed and snapshot transcript data, and
stops the session. The package also supports bounded execution-run streams
through `client.runs.startStream(...)`; their iterator is cancelled on normal
completion, early return, abort, or `client.close()`.
