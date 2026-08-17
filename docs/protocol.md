# Protocol

This document describes the Happier wire protocol as implemented in `apps/server`. The protocol is intentionally small: JSON over HTTP for reads/actions and Socket.IO for real-time sync. Persisted content uses explicit plain or encrypted domain representations; see `encryption.md` for mode, key-ownership, and encoding boundaries. For the full HTTP surface and auth flows, see `api.md`.

## Transport and versioning
- HTTP API: JSON requests/responses on `/v1` and `/v2` routes.
- WebSocket: Socket.IO server at path `/v1/updates` (transports: websocket, polling).
- CORS: `*` (server-side).

## Protocol design motivations
The protocol is designed to stay minimal, explicit, and resilient under intermittent connectivity. A few guiding principles shape naming, payloads, and versioning:

- **Small surface area over completeness.** Routes and events exist only when they provide a clear sync primitive (e.g., sessions, artifacts, KV). If a capability can be expressed as data within an existing primitive, it should be.
- **Explicit event types and short keys.** Update payloads use `t` for the event type and concise field names (`sid`, `id`, `seq`) to keep message size down without hiding meaning. These names are stable because they are used across clients.
- **Separation of persistent vs. ephemeral.** Anything that must be recoverable after reconnect is an `update` event with a sequence number. Presence and usage are `ephemeral` to avoid state confusion and minimize storage.
- **Monotonic ordering at the user level.** `UpdatePayload.seq` is a single per-user counter. This makes client reconciliation simple: apply updates in order and you are consistent for that user.
- **Optimistic concurrency by default.** Versioned fields (metadata, agent state, artifact parts, access keys, KV) require `expectedVersion`. This prevents silent overwrites and keeps conflict resolution client-driven.
- **Explicit storage boundaries.** E2EE payloads remain opaque to the server. Plain-account and plain-Session values are server-readable by design and travel as strict `{ t: "plain", v }` domain envelopes, sometimes base64-encoded by byte-oriented routes. Authentication, authorization, recipient projection, and TLS still apply. Optional server-at-rest sealing is persistence-only and never appears on the public wire.
- **Released compatibility over breaking changes.** Evolve released routes/events additively or through explicit negotiation and seam-owned translation; do not mutate existing wire semantics in place or create competing domain owners. Baselines, mixed-version directions, predecessor rules, and removal conditions are defined in `compatibility.md`.
- **Avoid full REST verbs.** Reads are primarily `GET`, while writes/actions are primarily `POST`, with `DELETE` used when the intent is unambiguous. We avoid the full REST palette because many mutations are not cleanly tied to a single entity or involve more than CRUD logic. Keeping to `GET` + `POST` (plus occasional `DELETE`) makes the client simpler and the protocol clearer.

If a new protocol field or event is proposed, it should answer: does this create a durable sync primitive, or can it be encoded inside the existing domain-owned stored-content representation without expanding the API surface?

## Authentication
Most endpoints require `Authorization: Bearer <token>`. The same token is also used in the Socket.IO handshake. Full auth flows and endpoints are documented in `api.md`.

## WebSocket connection
### Handshake
Connect with Socket.IO using:

```
path: "/v1/updates"
auth: {
  token: "<bearer token>",
  clientType: "user-scoped" | "session-scoped" | "machine-scoped",
  sessionId?: "<session id>",
  machineId?: "<machine id>",
  accountStoredContentCompatibility?: { v: 1, protocolVersion: 4 }
}
```

Rules enforced server-side:
- `token` is required.
- `session-scoped` requires `sessionId`.
- `machine-scoped` requires `machineId`.
- The stored-content declaration is orthogonal to the strict Session-sync
  declaration. Missing or malformed is legacy, never current by inference.
- Legacy sockets remain connected. The server applies compatibility at the operation
  that would expose or mutate current-format content and leaves unaffected operations
  available.

Current HTTP clients make the same protocol `4` declaration with
`x-happier-account-stored-content-protocol: 4`. The server currently advertises
stored-content implementation protocol `3`, while protocol `2` remains the minimum
compatibility floor for incumbent stored-content operations. A current-format request
from a legacy caller receives the strict account-stored-content
client-upgrade-required response before exposure or mutation. Feature bits advertise
server availability; they do not identify caller compatibility.

### Connection types
- `user-scoped`: receives account-wide updates.
- `session-scoped`: receives updates for a specific session only.
- `machine-scoped`: used by daemons; receives machine updates and emits machine state.

### Server -> client events
The server emits two event types:

#### `update`
Persistent sync events. Payload shape:
```
{
  id: string,
  seq: number,
  body: { t: string, ... },
  createdAt: number
}
```

#### `ephemeral`
Transient presence/usage events. Payload shape:
```
{
  type: string,
  ...
}
```

### Update event types
Field names below match on-wire payloads.

- `new-session`
  - `body`: `{ t: "new-session", id, seq, metadata, metadataVersion, agentState, agentStateVersion, dataEncryptionKey, encryptionMode?, active, activeAt, createdAt, updatedAt }`

- `update-session`
  - `body`: `{ t: "update-session", id, metadata?, agentState? }`
  - `metadata`: `{ value, version }` or null
  - `agentState`: `{ value, version }` or null

- `delete-session`
  - `body`: `{ t: "delete-session", sid }`

- `new-message`
  - `body`: `{ t: "new-message", sid, message: { id, seq, content, localId, createdAt, updatedAt } }`

- `update-account`
  - `body`: `{ t: "update-account", id, settings?, github? }`

- `new-machine`
  - `body`: `{ t: "new-machine", machineId, seq, metadata, metadataVersion, daemonState, daemonStateVersion, dataEncryptionKey, active, activeAt, createdAt, updatedAt }`

- `update-machine`
  - `body`: `{ t: "update-machine", machineId, metadata?, daemonState?, activeAt? }`

- `new-artifact`
  - `body`: `{ t: "new-artifact", artifactId, seq, header, headerVersion, body, bodyVersion, dataEncryptionKey, createdAt, updatedAt }`

- `update-artifact`
  - `body`: `{ t: "update-artifact", artifactId, header?, body? }`

- `delete-artifact`
  - `body`: `{ t: "delete-artifact", artifactId }`

- `relationship-updated`
  - `body`: `{ t: "relationship-updated", uid, status, timestamp }`

- `new-feed-post`
  - `body`: `{ t: "new-feed-post", id, body, cursor, createdAt }`

- `kv-batch-update`
  - `body`: `{ t: "kv-batch-update", changes: [{ key, value, version }] }`

### Ephemeral event types
- `activity`: `{ type: "activity", id: sessionId, active, activeAt, thinking? }`
- `machine-activity`: `{ type: "machine-activity", id: machineId, active, activeAt }`
- `usage`: `{ type: "usage", id: sessionId, key, tokens, cost, timestamp }`
- `machine-status`: `{ type: "machine-status", machineId, online, timestamp }`

### Client -> server WebSocket events
- `ping` -> callback `{}`

- `update-metadata`
  - `{ sid, metadata, expectedVersion }`
  - Response: `{ result: "success", version, metadata }` or `{ result: "version-mismatch", version, metadata }`

- `update-state`
  - `{ sid, agentState, expectedVersion }`
  - Response: `{ result: "success", version, agentState }` or `{ result: "version-mismatch", version, agentState }`

- `message`
  - `{ sid, message, localId? }`
  - Creates a new Session message and emits `new-message` to other connections.
  - `message` is `{ t: "encrypted", c }` for an E2EE Session or `{ t: "plain", v }` for a plain Session. Legacy ciphertext strings normalize to the encrypted branch. The server rejects a kind that does not match the Session's persisted mode.

- `session-alive`
  - `{ sid, time, thinking? }`
  - Emits `ephemeral` activity to user-scoped connections.

- `session-end`
  - `{ sid, time }`
  - Marks session inactive and emits `ephemeral` activity.

- `usage-report`
  - `{ key, sessionId?, tokens, cost }`
  - Stores usage report and optionally emits `ephemeral` usage for the session.

- `machine-alive`
  - `{ machineId, time }`
  - Emits `ephemeral` machine-activity.

- `machine-update-metadata`
  - `{ machineId, metadata, expectedVersion }`
  - Response: `{ result: "success", version, metadata }` or `{ result: "version-mismatch", version, metadata }`

- `machine-update-state`
  - `{ machineId, daemonState, expectedVersion }`
  - Response: `{ result: "success", version, daemonState }` or `{ result: "version-mismatch", version, daemonState }`

- `artifact-read`
  - `{ artifactId }`
  - Response: `{ result: "success", artifact }` or `{ result: "error", message }`

- `artifact-create`
  - `{ id, header, body, dataEncryptionKey }`
  - Response: `{ result: "success", artifact }` or `{ result: "error", message }`

- `artifact-update`
  - `{ artifactId, header?, body? }` where `header` and `body` include `data` + `expectedVersion`
  - Response: `{ result: "success", header?, body? }` or `{ result: "version-mismatch", header?, body? }`

- `artifact-delete`
  - `{ artifactId }`
  - Response: `{ result: "success" }` or `{ result: "error", message }`

- `access-key-get`
  - `{ sessionId, machineId }`
  - Response: `{ ok: true, accessKey? }` or `{ ok: false, error }`

- `rpc-register`
  - `{ method }` -> server emits `rpc-registered`

- `rpc-unregister`
  - `{ method }` -> server emits `rpc-unregistered`

- `rpc-call`
  - `{ method, params }` -> callback `{ ok, result? | error? }`
  - Server forwards to the registered socket via `rpc-request` (ack-based).

## HTTP endpoints by area
See `api.md` for the full HTTP endpoint catalog and auth flows.

## Sequencing and concurrency
- `UpdatePayload.seq` is the per-user update sequence (monotonic) used for sync ordering.
- Sessions, machines, and artifacts have their own `seq` fields used by clients for ordering.
- Versioned fields (metadata, agentState, daemonState, artifact header/body, access keys, KV) use optimistic concurrency with `expectedVersion` and return a version-mismatch response containing the current version/data.

## Authentication and content-key ownership

A bearer token, external OAuth/OIDC identity, GitHub identity, or mTLS identity can be
sufficient to authenticate and authorize a plain account. Authentication material is
not Account E2EE material and the protocol never derives one from the other.

A genuine token-only credential has no recovery secret, Account machine key, content
key, or fabricated replacement. “Keyed” and “keyless” are retained only where they
are exact historical route/identifier names; protocol prose distinguishes token-only
credentials, E2EE credentials, Account mode, and each row's persisted representation.
If an authorized token-only client reads a retained E2EE row, the domain reports a
typed locked/migration-required result; it does not return an empty/default value or
retry the bytes as plaintext.

The complete token-only external-auth/UI/daemon onboarding flow remains
activation-closed during the current expand/migrate rollout. Current source contains
the token-only credential, stored-content declaration, domain fences, and Session
layout-1 path, but advertised configuration, schemas, source presence, or readers do
not by themselves mean the end-to-end token-only flow is active.

The current source boundary is green for genuine token-only OAuth/mTLS, the E2EE-only
Account cipher, Machine/Todo/Artifact caller fences and producers, the global
declaration, Session layout 1 across Protocol/server/CLI/UI/runtime, the
Provider/MCP/Memory/resume/attach/prompt-Artifact consumers, and the final Connected
Services handoff, which reports 226 tests green. Protocol and Server production
TypeScript 7 are green. Full CLI TypeScript 7 is blocked only by unrelated moving
Plugin/Runtime files; direct UI TypeScript 7 is green. Mixed-version, database, loaded-runtime, two-client, daemon,
and platform gates remain open. Account-transition
amendment `PLAINTEXT-ACCOUNTS-2026-07-30.7` is source-green at its Protocol, server,
CLI, and UI first-key owner/Settings/callback/storage boundaries. One bounded, server-scoped
OAuth or mTLS continuation carries the exact request, proof, pending handle, and seed;
it expires explicitly and is consumed once from authoritative E2EE Settings hydration
without starting a new challenge. Credentials persist before custody clears;
the strict literal `migrationSubmissionAttempted?: true` marker is persisted with the
pending handle before the first migration POST; a failed custody write produces zero
POSTs. Only a definitive first-submission 4xx except 408/429 may clear custody.
Ambiguous transport, 5xx, 408/429, commit-observed/post-persist failures, and every
later failure retain custody. The root-independent final rerun is green at 45/45,
direct UI TypeScript 7 is green, and the scoped diff check is green pre-gap evidence.
The two source corrections have since landed: first-key resume owns one exact POST per
resume with hidden API backoff disabled only for this path, and marked active-server
mismatch retains custody before rejection with zero POST/persist/clear while unmarked
mismatch keeps prior cleanup. Module-local mutation serialization and bounded
primary→legacy→global lookup close the stale-state race and legacy-reader omission;
root-independent evidence is 67/67 including exact concurrency, direct UI TypeScript
7, and scoped diff green. Cross-tab/worker serialization remains a platform residual.
A separately approved client-lifecycle amendment
`PLAINTEXT-ACCOUNTS-2026-07-31.8` requires ordinary logout and different-token
replacement to fail before credential/app-state mutation and route to **Finish
encryption setup** while marked custody exists. Successful same-token recovery keeps
the user signed in for recovery-key backup/copy. Only warning-backed exact
abandonment may remove the marked record before credentials are deleted or replaced;
clear failure preserves credentials, and 401/token invalidation is not abandonment.
Amendment `.8` is `PLANNED`/`IMPLEMENTATION_PENDING`; amendment `.7` remains
`SOURCE_GREEN_PROVISIONAL`, `CROSS_TAB_CUSTODY_RESIDUAL_OPEN`, and
`IMPLEMENTED_NOT_LIVE_VERIFIED`; source presence does not activate it. The managed
stack is process-current and healthy, but the keyless/plaintext/account-opt-out
features are disabled, so behavioral `.7` loaded-runtime QA is unproven.
PostgreSQL/MySQL execution is unavailable, and an
isolated GitHub browser flow was blocked before page-body execution by the MachPort
sandbox. Two-client, daemon, mobile-preview, and supported-platform gates remain open.

Session metadata layout 1 is authorized by the approved `.6` contract and current
source carries its strict plain/encrypted owner envelope, compatibility-declared fresh
writer, owner migration, and canonical recipient projection. Plain owner metadata is
server-readable but owner-only; non-owner roles receive the strict shared projection.
Current-format operations require a current caller declaration. Release readiness
still depends on the remaining mixed-version, database, composed, and platform checks;
it does not depend on an operator activation mode or legacy socket drainage.

Session transcript mode stays per Session, but the layout-1 owner envelope is
Account-scoped and must transition with Account mode. Approved amendment `.7` adds a
required bounded `sessions: assert_empty | migrate` directive. Each item identifies
one active or archived layout-1 Session with exact layout, metadata/Agent-state
versions, expected owner envelope, and target owner envelope. The Account transition
locks first, delegates to the existing Session tuple CAS/projector, changes only the
owner envelope plus canonical versions/cursors, and mutates Account mode/key last.

For first E2EE-key enrollment on a truly keyless Account, `.7` requires a fresh,
short-lived external-auth identity proof from the existing GitHub/OIDC/OAuth/mTLS
owner; the stored bearer alone never qualifies. Exact lost-response replay is bound
by one canonical request digest used for signatures and fresh-auth binding. The
client-visible change stream stores only a domain-separated server-secret binding,
not the raw digest, in the existing final account/self `AccountChange` hint. Only an
identical request with the exact final cursor and post-state succeeds read-only;
missing/pruned/mismatched evidence fails closed, with no receipt table or worker.

Current source implements these `.7` additions. Protocol owns the strict Session
directive and canonical request digest; the server owns Account-first Session CAS,
transactional fresh-auth consumption, the server-secret replay binding, and exact
zero-write post-state recognition; the UI owner/callback/storage boundary retains and
replays one bounded server-scoped OAuth or mTLS continuation. Authoritative E2EE
Settings hydration performs one bounded exact retry without a new challenge;
credentials persist before custody clears. The strict literal
`migrationSubmissionAttempted?: true` marker is persisted with the pending handle
before the first POST, and a failed custody write produces zero POSTs. Only a
definitive first-submission 4xx except 408/429 may clear custody; ambiguous
transport/5xx/408/429, commit-observed/post-persist, and every later failure retain it.
The root-independent final rerun is green at 45/45, direct UI TypeScript 7 is green,
and the scoped diff check is green pre-gap evidence. First-key resume now owns one
exact POST per resume with hidden API backoff disabled only for this path; marked
active-server mismatch retains custody before rejection with zero POST/persist/clear,
while unmarked mismatch keeps prior cleanup. Module-local mutation serialization and
bounded primary→legacy→global lookup close the stale-state race and legacy-reader
omission; root-independent evidence is 67/67 including exact concurrency, direct UI
TypeScript 7, and scoped diff green. Cross-tab/worker serialization remains a platform
residual. Approved amendment `.8` guards ordinary logout and different-token
replacement before mutation, keeps successful same-token recovery signed in for
recovery-key backup/copy, and allows credential destruction only after
warning-backed exact abandonment removes the observed marked record. A clear failure
preserves credentials; 401/token invalidation is not abandonment. `.8` is
`PLANNED`/`IMPLEMENTATION_PENDING`; `.7` remains `SOURCE_GREEN_PROVISIONAL`,
`CROSS_TAB_CUSTODY_RESIDUAL_OPEN`, and `IMPLEMENTED_NOT_LIVE_VERIFIED`.
PostgreSQL/MySQL execution is unavailable, and an
isolated GitHub browser flow was blocked before page-body execution by the MachPort
sandbox. Behaviorally activated loaded-runtime/two-client behavior, daemon restart,
mobile preview, and supported-platform proof remain open.

## Implementation references
- API routes: `apps/server/sources/app/api/routes`
- Socket handlers: `apps/server/sources/app/api/socket`
- Event routing: `apps/server/sources/app/events/eventRouter.ts`
