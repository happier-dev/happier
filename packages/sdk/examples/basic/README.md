# Basic SDK example

Start the local daemon, create an API Token in Settings, read the daemon's
current HTTP port, then run the example:

```sh
happier daemon start
DAEMON_PORT="$(happier daemon status --json | jq -er '.daemon.httpPort')"
HAPPIER_API_ENDPOINT="http://127.0.0.1:$DAEMON_PORT" \
HAPPIER_TOKEN='hap_v1_…' \
HAPPIER_AGENT_ID='codex' \
yarn tsx packages/sdk/examples/basic/index.ts
```

The example connects to the daemon, spawns a Session with the installed Agent
named by `HAPPIER_AGENT_ID` (`codex` by default), sends one message,
opens and releases one transcript-follow lease, prints the finite assistant
history result, and always stops the Session and closes the client.

For server-origin routing and explicit machine selection, see the
[comprehensive example](../comprehensive/README.md). Contributed Action
discovery and invocation are documented in the package's main README because
they require an installed plugin and its declared input schema.
