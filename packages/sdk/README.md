# `@happier-dev/sdk`

Typed Node.js client for Happier's authenticated Action API.

The current Developer Preview supports server-side Node.js use. Public Action
routes do not enable CORS, so this is not a browser client for arbitrary web
origins; same-origin browser delivery has not been proven as a supported
environment. Do not put an API Token in browser code.

```ts
import { connect } from '@happier-dev/sdk';

const apiToken = process.env.HAPPIER_TOKEN;
if (!apiToken) throw new Error('Set HAPPIER_TOKEN to an API Token.');

const happier = connect({
  endpoint: 'http://127.0.0.1:3210',
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

`agent` is an exact Agent routing id such as `'codex'`; it is resolved from
the target daemon's current inventory. If it is not installed, disabled, or
does not expose a Session-capable identity, `sessions.spawn()` rejects with
`HappierAgentUnavailableError` and its typed `reason`.

At a daemon-local endpoint, root `happier.sessions.spawn()` deliberately omits
the routing target, so the daemon uses its current Machine. It does not perform
Machine discovery or choose a server-side default. At a server endpoint, that
same unbound call rejects with the canonical `target_required` Action error.
Choose an exact target explicitly with
`happier.machine(machineId).sessions.spawn(...)`; the machine-bound client
keeps that target fixed for its inventory lookup and Session creation.

When you request `initialMessage`, `sessions.spawn()` resolves only after the
canonical initial-input disposition is `accepted` or `alreadyAccepted`. If the
Session was committed but that message is `rejected`, `outcomeUnknown`, or
`notRequested`, it rejects with `HappierSessionInitialInputError`. Its
`session` is the committed Session handle and `result.initialInput` preserves
the canonical disposition; no retry or Session deletion is performed. Recover
explicitly, for example with `error.session.send(...)`.

`actions.execute(actionId, input, options)` is the raw Action call. Each
namespaced Action method offers the same call with typed input and output. Use
`actions.search(...)` for Action discovery and `actions.invoke(...)` for a
dynamically installed contributed Action.

When connected to the Account server, `machines.list()` reads its existing
authenticated `/v1/machines` bootstrap and returns only target-selection fields.
Use the selected id with `machine(id).sessions.spawn(...)`. This bootstrap is
separate from the `actions.machines.list(...)` operation and does not select a
default machine for a server Action request.

## API reference

The [API inventory](./API.md) lists every exported symbol. Its companion
`api-declarations.md` records signatures; do not replace either with a
hand-maintained method list.

The client accepts an API Token only. It never reads CLI profiles,
persists credentials, accepts Account signing or encryption material, retries a
mutation, or fails a mutation over to another endpoint. Abort individual calls
with `AbortSignal`; `close()` aborts outstanding calls. A server-mediated request
is readable by that server. Select the daemon-local endpoint when direct local
transport is required.

The environment lookup in the example is caller code. `connect()` requires its
`token` option and never reads `HAPPIER_TOKEN`, a CLI profile, or any credential
store implicitly.

Transcript following is a finite async iterator. Ending the iterator stops
following through `transcript.unfollow`. Snapshot methods, including subagent
watch, are ordinary methods.

## Release posture

This package is a Developer Preview. The repository source remains private at
version `0.0.0`; external publication requires the release approval workflow.
Preview APIs can change before a stable release.
