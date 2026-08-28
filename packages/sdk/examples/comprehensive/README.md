# Comprehensive SDK example

This dogfood recipe covers daemon-local and Account-server origins, explicit
machine selection, Session lifecycle helpers, and cleanup. It uses the Agent
named by `HAPPIER_AGENT_ID` (`codex` by default), which must be installed on the
selected machine.

Use the [basic example](../basic/README.md) for the shortest local happy path.
For a daemon-local endpoint, obtain its current port and let that daemon supply
its own Machine target:

```sh
DAEMON_PORT="$(happier daemon status --json | jq -er '.daemon.httpPort')"
HAPPIER_API_ENDPOINT="http://127.0.0.1:$DAEMON_PORT" \
HAPPIER_TOKEN='hap_v1_…' \
HAPPIER_ENDPOINT_MODE=daemon \
HAPPIER_AGENT_ID=codex \
yarn tsx packages/sdk/examples/comprehensive/index.ts
```

For the configured Account server, set the server origin. The example selects
a Machine automatically only when exactly one row from `machines.list()` is
active, not revoked, and not replaced. Otherwise set `HAPPIER_MACHINE_ID`
explicitly.

```sh
HAPPIER_API_ENDPOINT='https://configured-server.example' \
HAPPIER_TOKEN='hap_v1_…' \
HAPPIER_ENDPOINT_MODE=server \
HAPPIER_MACHINE_ID='machine-id' \
HAPPIER_AGENT_ID=codex \
yarn tsx packages/sdk/examples/comprehensive/index.ts
```

Contributed Action discovery and invocation are documented in the main SDK
README and require an explicit installed plugin/action rather than selecting an
arbitrary first search result.
