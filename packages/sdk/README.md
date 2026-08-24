# `@happier-dev/sdk`

Typed Node.js client for Happier's authenticated Action API.

The current Developer Preview supports server-side Node.js use. Public Action
routes do not enable CORS, so this is not a browser client for arbitrary web
origins; same-origin browser delivery has not been proven as a supported
environment. Do not put an API Token in browser code.

### Daemon-local onboarding

For a daemon-local endpoint, use the root client. Its Action requests omit a
target, so the daemon executes on its current Machine.

```ts
import { connect } from '@happier-dev/sdk';

const apiToken = process.env.HAPPIER_TOKEN;
if (!apiToken) throw new Error('Set HAPPIER_TOKEN to an API Token.');
const endpoint = process.env.HAPPIER_API_ENDPOINT;
if (!endpoint) throw new Error('Set HAPPIER_API_ENDPOINT.');

const happier = connect({
  endpoint,
  token: apiToken,
});

const session = await happier.sessions.spawn({
  directory: process.cwd(),
  agent: 'codex',
  initialMessage: 'Inspect the failing tests.',
});

await session.send('Please fix the smallest owning cause.');
await session.waitForIdle();
happier.close();
```

For daemon-local use, obtain the current port from the daemon status contract;
the port is not fixed:

```sh
DAEMON_PORT="$(happier daemon status --json | jq -er '.daemon.httpPort')"
export HAPPIER_API_ENDPOINT="http://127.0.0.1:$DAEMON_PORT"
```

### Account-server onboarding

`agent` is an exact Agent routing id such as `'codex'`; it is resolved from
the target daemon's current inventory. If it is not installed, disabled, or
does not expose a Session-capable identity, `sessions.spawn()` rejects with
`HappierAgentUnavailableError` and its typed `reason`.

At a daemon-local endpoint, root `happier.sessions.spawn()` deliberately omits
the routing target, so the daemon uses its current Machine. It does not perform
Machine discovery or choose a server-side default. At a server endpoint, that
same unbound call rejects with `HappierActionError` whose `code` is
`target_required`. Discover and select an exact server target before creating a
Session:

```ts
const serverAccount = connect({ endpoint, token: apiToken });
const machine = (await serverAccount.machines.list()).find((candidate) => (
  candidate.active && candidate.revokedAt === null && candidate.replacedByMachineId === null
));
if (!machine) throw new Error('No active machine is available.');
const serverClient = serverAccount.machine(machine.id);
const session = await serverClient.sessions.spawn({ directory: process.cwd(), agent: 'codex' });
```

The machine-bound client keeps that target fixed for its inventory lookup and
Session creation. The packaged basic example makes this endpoint choice
explicit: `HAPPIER_ENDPOINT_MODE=daemon` omits a target, while
`HAPPIER_ENDPOINT_MODE=server` enumerates and selects one.

`HappierActionError` means the Action API admitted the request and the Action
failed with a typed result. `HappierTransportError` instead means the SDK could
not complete or validate the HTTP exchange, such as a network failure, a
non-success HTTP status, invalid JSON, or an invalid response envelope.

Both the daemon-local and server origins cap the complete serialized response
envelope—not only the Action result—at 24,000,000 UTF-8 bytes. If execution
finishes but the envelope would exceed that limit, the SDK rejects with
`HappierActionError`: `code` is `result_too_large` and `details` contains
`{ executionCompleted: true, maxSerializedBytes: 24000000 }`. The Action may
already have committed a mutation, so do not blindly retry it. Inspect current
state or use the Action owner's idempotency contract. For large data, return
Artifact references, use an existing stream Action, or expose bounded or
paginated reads instead of one oversized inline result. The request-body limit
is 32 MiB (33,554,432 bytes). The server-to-daemon relay reserves a 33 MiB
(34,603,008-byte) request carrier, leaving one MiB for its framing.

When you request `initialMessage`, `sessions.spawn()` resolves only after the
canonical initial-input disposition is `accepted` or `alreadyAccepted`. If the
Session was committed but that message is `rejected`, `outcomeUnknown`, or
`notRequested`, it rejects with `HappierSessionInitialInputError`. Its
`session` is the committed Session handle and `result.initialInput` preserves
the canonical disposition; no retry or Session deletion is performed. Recover
explicitly, for example with `error.session.send(...)`.

`actions.execute(actionId, input, options)` is the raw Action call. Each
namespaced Action method offers the same call with typed input and output. Use
`actions.action.spec.search(...)` (also available as the `actions.search(...)`
convenience method) to discover a contributed Action's qualified id,
`actions.action.spec.get(...)` to read its declared input schema, and
`actions.invoke(...)` with its `{ pluginId, localId }` identity to invoke it.

The API setting starts Allowed for API-eligible built-in and contributed
Actions, so Action Settings add no approval prompt by default. A non-safe
contributed Action still requires the host's live current-intent confirmation;
Allowed does not suppress that independent safety contract. A present user can
also change an Action's API setting to require approval or turn it off. That
setting does not raise an API Token above `account_automation`: token
management, approval decisions, and other present-user controls reject with
`present_user_required`.

When connected to the Account server, `machines.list()` reads its existing
authenticated `/v1/machines` bootstrap and returns only target-selection fields.
Use the selected id with `machine(id).sessions.spawn(...)`. This bootstrap is
separate from the `actions.machines.list(...)` operation and does not select a
default machine for a server Action request.

## API reference

The generated [API inventory](./API.md) is a census of exported package symbols,
not a complete Action method reference. Its companion `api-declarations.md`
records exported signatures. Use the generated
[Host Actions reference](https://happier.dev/plugins/api/host-actions) for
built-in Action contracts. At runtime, use `actions.search(...)` and
`actions.action.spec.get(...)` for discovery, then call
`actions.execute(...)` when the Action id is selected dynamically. Do not
replace those sources with a hand-maintained method list.

The client accepts an API Token only. It never reads CLI profiles,
persists credentials, accepts Account signing or encryption material, retries a
mutation, or fails a mutation over to another endpoint. Abort individual calls
with `AbortSignal`; `close()` aborts outstanding calls. A server-mediated request
is readable by that server. The public endpoint is
`POST /v1/actions/:actionId`: use either a daemon-local
`http://127.0.0.1:<daemon-port>` endpoint or a configured server origin. The
server origin relays to the exact selected machine, so it works with a
NAT-hidden daemon but needs an explicit target. Select the daemon-local endpoint
when direct local transport is required. Server revocation takes effect on the
next verification; a daemon that has a positive validation result may accept a
revoked token for at most 60 seconds and returns `auth_unavailable` after that
cache expires if it cannot reach the server.

For a mutating Action, the SDK generates a request ID when the caller does not
supply one, but that generated value is not returned. If you may need to
reconcile an uncertain mutation outcome, generate and retain the ID in your own
code and pass it as `options.requestId`. Request IDs are correlation unless the
Action's own contract gives them idempotency semantics; the SDK provides no
receipt store or automatic retry subsystem.

The environment lookup in the example is caller code. `connect()` requires its
`token` option and never reads `HAPPIER_TOKEN`, a CLI profile, or any credential
store implicitly.

`session.followTranscript()` is a finite, demand-driven async iterator: it does
not keep fetching while its consumer is not awaiting the next item, and an
early loop exit or `close()` releases its `transcript.unfollow` lease. Use
`runs.startStream({ runId, ... })` for a genuine execution-run stream. Its
handle exposes `runId`, `streamId`, `cancel()`, and an async iterator; normal
completion, early iterator return, an abort signal, and `close()` all cancel
the canonical stream. A machine-bound client's stream start, reads, and cancel
stay on that same target. Snapshot Actions remain ordinary methods.

## Release posture

This package is a Developer Preview. The repository source remains private at
version `0.0.0` until the first-publication gates pass and release work is
explicitly authorized. Preview APIs can change before a stable release.
