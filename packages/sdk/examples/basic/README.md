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
HAPPIER_AGENT_ID=codex \
node --import tsx ./node_modules/@happier-dev/sdk/examples/basic/index.ts
```

For an Account-server endpoint, the example uses the authenticated machine-list
bootstrap to select an active machine, then binds subsequent Actions to that
exact id. For a daemon-local Action endpoint, set `HAPPIER_MACHINE_ID` because
that endpoint intentionally does not expose Account machine discovery.

Optional environment variables are `HAPPIER_MACHINE_ID`,
`HAPPIER_WORKSPACE_PATH`, and `HAPPIER_AGENT_ID`. They respectively select the
daemon-local target machine, spawned workspace, and catalog Agent routing id.
`HAPPIER_AGENT_ID` defaults to `codex`, so the example calls
`sessions.spawn({ agent: 'codex', ... })` without exposing a server id or a
qualified plugin identity. The example spawns a session, waits, sends a
follow-up, waits again, prints JSON containing the session id and transcript,
and stops the session.
