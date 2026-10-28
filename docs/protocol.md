# Protocol

This document describes the Happier wire protocol as implemented in `apps/server`. The protocol is intentionally small: JSON over HTTP for reads/actions and Socket.IO for real-time sync. Most payloads are end-to-end encrypted client-side; see `encryption.md` for the encryption boundaries and encoding details. For the full HTTP surface and auth flows, see `api.md`.

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
- **Client-side encryption boundaries.** The server never needs to understand plaintext. The protocol therefore treats most payloads as opaque strings or base64 blobs, which keeps server logic simple and privacy guarantees strong.
- **Released compatibility over breaking changes.** Evolve released routes/events additively or through explicit negotiation and seam-owned translation; do not mutate existing wire semantics in place or create competing domain owners. Baselines, mixed-version directions, predecessor rules, and removal conditions are defined in `compatibility.md`.
- **Avoid full REST verbs.** Reads are primarily `GET`, while writes/actions are primarily `POST`, with `DELETE` used when the intent is unambiguous. We avoid the full REST palette because many mutations are not cleanly tied to a single entity or involve more than CRUD logic. Keeping to `GET` + `POST` (plus occasional `DELETE`) makes the client simpler and the protocol clearer.

If a new protocol field or event is proposed, it should answer: does this create a durable sync primitive, or can it be encoded inside existing encrypted payloads without expanding the API surface?

## Plaintext message storage (development)

Before comparing or storing plaintext message envelopes, the server removes actual
NUL characters (U+0000) from string values, including nested tool output. PostgreSQL
JSONB cannot represent NUL. Literal text such as `\u0000` and other control
characters remain unchanged. Transcript and pending-message ingress
share `normalizeSessionMessageContentForStorage`; retries compare the normalized
content. A fixed `nul-removed` warning records normalization without message data.
NUL-bearing object keys and ciphertext are rejected as `invalid-params`: rewriting
keys could merge distinct fields, and encrypted content is opaque. This correction
is development source behavior; release availability is tracked separately.

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
  machineId?: "<machine id>"
}
```

Rules enforced server-side:
- `token` is required.
- `session-scoped` requires `sessionId`.
- `machine-scoped` requires `machineId`.

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
  - `body`: `{ t: "new-session", id, seq, metadata, metadataVersion, agentState, agentStateVersion, dataEncryptionKey, active, activeAt, createdAt, updatedAt }`

- `update-session`
  - `body`: `{ t: "update-session", id, metadata?, agentState? }`
  - `metadata`: `{ value, version }` or null
  - `agentState`: `{ value, version }` or null
  - Optional pending-request projections use `pendingPermissionRequestCount`, `pendingUserActionRequestCount`, and nullable `pendingRequestObservedAt`.
  - Pending request counts describe the outstanding requests in Agent state, including independent execution runs. Foreground completion, cancellation, publisher close, and released-UI Stop preserve them; those lifecycle events do not own every request in the Session. The acknowledged Agent-state writer commits the request state and derived counts together, then publishes their committed projection.
  - The development UI reconciles request content, counts and list flags together under `agentStateVersion` through the shared session projection owner. A delayed older version cannot restore a pending count after settlement clears `pendingRequestObservedAt` to null. Metadata keeps its independent version ordering; cache-only public request updates retain their envelope version without claiming that encrypted detail has been decrypted. Composer status subscribes to the existing pending-request summary so transcript-only settlement also reaches an already mounted composer.
  - Development request-settlement delivery retains encrypted, request-specific completion intents in the existing CLI runtime mutation journal before releasing the provider waiter. Delivery merges each exact occurrence into current Agent state through the existing versioned writer; it preserves independent and newer requests. Normal delivery retries while the runtime is active, and a runtime reopening the same Session replays admitted intents after restart. Runtime journals remain runtime-owned; daemon terminal recovery does not take them over. This reliability improvement requires the updated CLI, uses the existing server wire contract, and is not a release availability claim.


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

In current development source, execution-run activity uses the existing public
`status`, `runClass` and optional `turnInFlight` facts through
`isExecutionRunActive`. A running long-lived handle with an observed
`turnInFlight: false` remains available for follow-up without contributing
background work. Bounded runs remain active until their outcome settles;
provisioning and older producers without a turn observation remain conservatively
active. The CLI publishes the same work transitions to runtime activity and its
public run observers. Reachability and retained handle lifetime remain separate
from this current-work projection.

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
  - Creates a new session message (encrypted payload) and emits `new-message` update to other connections.

- `session-alive`
  - `{ sid, time, thinking? }`
  - In the current development server, the released event refreshes the exact machine-bound publisher's reachability. The server uses its receipt time, retains observations while coalescing writes, and does not derive runtime activity from the legacy `thinking` flag. See [presence ownership](backend-architecture.md#presence-and-activity).
  - Committed reachability is published through `publishSessionPublisherLifecycleUpdate` as session updates to interested participants.

- `session-end`
  - `{ sid, time }`
  - Closes the authorized publisher and publishes its inactive state through the same lifecycle-update owner.
  - The current development server also accepts the released UI v0.2.1 user-scoped Stop event. Its durable session update includes the initiating UI connection because the event has no authoritative response projection.

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

### Required session rows and resume (development)

The development `GET /v2/sessions` reader accepts `requiredSessionIds` as a JSON
array in the query. These access-checked rows join the ordinary initial-page
families without changing its cursor. `requiredOnly=true` reads only that family,
including visible archived rows, and returns no continuation cursor. The UI chunks
the encoded GET request line against nginx's default 8 KiB boundary, including
reader-support parameters and HTTP framing. This is a transport boundary, not an
account-size or row-count limit.

New UI readers verify every required ID actually returned. Older servers can
ignore the additive query; omitted IDs use the existing exact-read compatibility
path. A page omission is never proof of deletion. Exact reads retain the existing
nondisclosing JSON `404 { error: 'Session not found' }` for both missing and
inaccessible sessions. Unrecognized or unparseable 404 bodies, explicit permission,
authentication and transport failures remain failures rather than deletion.
When an overlapping organization refresh introduces required pins or explicit
attention standings, the UI awaits their hydration through the required-only list
operation, even if their IDs appeared in the ordinary page. Returned membership
alone does not prove readable materialization; omitted rows retain exact fallback.

A missing account changes cursor captures the current cursor before the existing
snapshot repair and checkpoints it only after successful repair. Every repair
requires materializing reads started after that capture: active refresh commands
finish before a fresh queue cycle, and the sessions queue drains any older shared
direct list read before fetching again. Existing wait budgets, stopped queues and
terminal failures still prevent checkpointing an incomplete repair. Established
cursors materialize each page's changed sessions through the same row reader
before checkpointing. Share, pin and membership changes still reconcile the
ordinary list; metadata/activity-only pages do not replace it. Targeted reads
preserve list pagination, while the ordinary resume refresh still recovers missed
activity ephemerals. Missing folder-assignment reads learn for their captured
account/server activation even when the requesting render effect is replaced;
scope changes discard stale results and newer cached assignments take precedence.

These additions describe development source, not released availability.

### Session organization (development)

`GET /v2/session-organization` returns the account-scoped organization snapshot.
Pins, folders, tags, ordering and workspace/group labels retain their existing
collections. Per-session appearance uses a separate `sessionAppearances`
collection; it does not extend the strictly parsed label-kind enum.

Clients request `includeSessionAppearances=true` to receive
`sessionAppearances: [{ sessionId, display, updatedAt }]`. The server omits the
field otherwise, preserving older strict snapshot readers. A client receiving
no field after requesting it treats session appearance as unsupported by that
server. The snapshot collection is bounded at 1,000 rows per account because
snapshots are list first-paint payloads. Only visible, unarchived sessions count
toward the write quota; retained appearances for archived or inaccessible sessions
do not consume it. Reads include only visible, unarchived sessions.

`PUT /v2/session-organization/appearances/:sessionId` accepts `{ display }` and
returns `{ appearance: { sessionId, display, updatedAt } }`. The display is the
existing opaque `{ t: 'encrypted', c }` or `{ t: 'plain', v }` organization
envelope; plain envelopes require a plain account. The server validates the
envelope but does not interpret colour or other display contents. `{ display:
null }` deletes the override idempotently and returns `{ appearance: null }`;
clearing an archived session remains allowed through the existing session-access
rule. Malformed request bodies follow the existing Fastify validation path and
return 400 `invalid-params`; handler-level validation failures return 400
`invalid-session-appearance`. Inaccessible sessions return 404 `Session not found`, and creating beyond the bound returns
409 `session-appearance-limit-exceeded`. Updating an existing row or clearing
one remains allowed at the bound.

The existing organization mutation owner commits the row, increments the account
organization checkpoint, and publishes a change hint with
`scope: 'sessionAppearances'` and the affected `sessionIds`. Account and session
deletion cascade to their appearance rows in PostgreSQL, SQLite and MySQL.
Project colours remain client-owned display content inside workspace labels.
These additions describe development source, not released availability.

The UI colour model and inheritance rule live in
`apps/ui/sources/sync/domains/session/organization/appearanceColor.ts`.
Display content uses `{ color: { kind: 'accent', key } }` or
`{ color: { kind: 'custom', hex: '#RRGGBB' } }`; custom hex values normalize to
opaque uppercase six-digit hex. Session overrides take precedence over workspace
colours. Workspace display content can carry both `label` and `color`.
`setWorkspaceDisplay` merges field intents through the existing label operation
and envelope owner, and removes a workspace label row only when both are empty.
Legacy import preserves existing server label rows, including colour-only rows.

For UI consumers, `useSessionListViewState` exposes
`setWorkspaceColor(workspaceKey, colorOrNull, { serverId }?)`,
`setSessionAppearance(sessionId, colorOrNull, { serverId }?)`,
`workspaceColorsV1`, and `sessionAppearancesSupported`. Handlers use the existing
organization mutation error path; session ids are unprefixed. Multi-server rows
pass their own server id. Project header items and session row models expose
`appearanceColor`. `hooks/session/useSessionAppearance.ts` provides
`useSessionAppearancesSupported(serverId)` for server-local action availability
and `useCustomSessionAppearanceColors(serverId?)` for distinct custom hex colours
currently in use. Mount the latter inside the open picker; its values are not
historical recency. Resolve theme accents with `resolveSessionAppearanceColor`.
Workspace colour actions remain available when per-session support is absent.

## Sequencing and concurrency
- `UpdatePayload.seq` is the per-user update sequence (monotonic) used for sync ordering.
- Sessions, machines, and artifacts have their own `seq` fields used by clients for ordering.
- Versioned fields (metadata, agentState, daemonState, artifact header/body, access keys, KV) use optimistic concurrency with `expectedVersion` and return a version-mismatch response containing the current version/data.

### Transcript catch-up and reading position

The following describes the current development implementation, not a new server protocol or a released client guarantee.

Account-change cursors, session sequence hints, and transcript paging cursors serve different purposes. A session hint announces newer durable content; it does not prove that this device has loaded the intervening rows. Likewise, acknowledging an account change need not download the entire transcript: the UI can retain the outstanding forward load in its existing deferred-transcript state. Failed shell loads, message loads, and revision repairs still block the affected checkpoint.

Development UI HTTP reads retain cancellation through response-body completion. Web reads use an inactivity window derived from the server heartbeat contract (15 seconds between pings plus a 45-second timeout); each received body chunk renews it. `EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS` overrides that window. Native fetch exposes no progress before completing a response, so only explicitly server-bounded reads (transcript pages and changes/cursor) use that pre-resolution deadline. Unpaged session metadata, organization snapshots, pending queues and draft hydration remain manually cancellable without a native total deadline. POST-based reads opt in explicitly at their owner, including draft read/list, KV bulk lookup and the native version check; KV value sizes are unbounded despite the key-count cap. Manual Retry cancels superseded reads, lets the old resume unwind and then starts a fresh resume; it preserves mutating requests and rejects stale resume materialization/checkpoints. It also cancels that resume's invalidation waits, including waits on a cycle parked in backoff, without stopping the cycle or changing its retry budget. Queued apply actions and later snapshot phases observe the same resume generation fence, so cancelled waits cannot authorize cursor advancement. Supersession is not a failed attempt: the existing API and invalidation retry owners immediately run a replacement without backoff or consuming their failure budget. A still-stalled replacement remains owned by that retry cycle. Read inactivity timeouts are logged by default and enter the existing retry owners.

The development UI supervises HTTP readiness separately from active sync socket recovery. A failed socket dial retains escalating demand through the shared managed connection policy without blocking healthy HTTP requests. Known HTTP unavailability suspends the socket lifecycle until reachability returns; an actual socket connection resets socket retry escalation. HTTP response reports carry the supervisor scope captured before dispatch. An authenticated 401, gateway 502/504, or 503 with a valid `Retry-After` or explicit restart marker can update endpoint readiness. Resource 403, generic 500, and unqualified route-level 503 responses remain operation-scoped. Dedicated authentication probes classify their own endpoint evidence, including account-level rejection.

`decideMessageCatchUpPolicy` owns hosted transcript catch-up decisions. The existing defaults allow three incremental pages, with a separate large-gap threshold of 500 sequence positions and a long-offline threshold of 30 minutes. Those positions are not necessarily main-transcript rows. Large backlogs go directly to the latest page when following the live tail; history readers defer forward loading. An explicit reopen can probe one page even when the session hint appears current. Known deferred backlog remains authoritative when that hint is stale; a failed catch-up read retains that demand for retry.

Latest-page catch-up merges rows into the retained cache and records omitted history through the existing tail-discontinuity owner. It does not clear cached history. The current viewport intent is checked again after asynchronous work: a reader who has scrolled away or entered a target window must not acquire a new live-tail display floor from the outstanding response. Forward-edge paging, target-window paging, and jump-to-bottom keep their existing distinct navigation responsibilities; visibility alone is not an instruction to jump to the bottom.

The shared message-page pipeline publishes coverage and received revisions only after decryption and application succeed. An unavailable encrypted row leaves the page retryable, rather than advancing past it. Realtime messages can arrive beyond a missing interval, so the deferred-transcript owner retains a gap floor independently of the highest observed message. A successful page acknowledges only the interval it covers; a successful latest snapshot transfers skipped history to the tail-discontinuity owner.

Revision repair uses message identities and available sequence hints to fetch bounded affected ranges, rather than replaying every row between distant edits. Each group uses the configured page size and can refresh already-known neighbors without inserting unseen, unrequested rows. It suppresses historical lifecycle events and does not change the visible target window or forward paging cursor. Already-current revisions count as repaired; missing or unavailable rows remain outstanding. Account-change hints are coalesced per session and retain only the latest hint, not a complete journal of edited message identities. Consequently, bounded repair cannot certify the freshness of every historical row outside the fetched ranges.

A repair captures the existing immutable stale-marker sequence map before reading. It can acknowledge those markers only while that exact snapshot remains current. Every new stale mark replaces the snapshot, including another edit to the same row at the same sequence position, so an older response cannot clear newer repair demand after a clear or reset.

### Direct transcript continuation

The development direct-session RPC response retains each agent's existing `truncated` boolean and adds optional `truncationReason: "page_limit" | "source_discontinuity"`. Old readers continue to see the original boolean; new readers use the explicit reason when present to distinguish an ordinary bounded page from invalidated source history. In particular, Claude can report `page_limit` while retaining its legacy `truncated: false`. A legacy response without a reason remains conservative.

Ordinary forward paging extends the accepted transcript without replacing a detached reader's anchor. A source discontinuity requires a successful latest read before replacement, and the direct cursor owner retains that recovery requirement until replacement succeeds. Network failure or a reader leaving the live tail during the request preserves the accepted transcript. This is separate from CLI session-message replay, whose continuation cursor must be compared with the cursor sent for that page, not the maximum row just applied.

A hosted/direct handoff or direct-link rebind can preserve the Session ID while changing transcript authority. The new source's initial window is staged before replacing the accepted rows, pagination and gap state; a failed read leaves that accepted state intact. In-flight reads capture their source identity, so a superseded response cannot publish rows, completion or paging state for the replacement source. Source identity follows transcript routing, not activity or backend-mode metadata.

After a bounded direct read or push reports a page-limited backlog, the next live-tail refresh or push stages the latest page instead of repeatedly replaying adjacent pages. A further capped push consumes that existing demand through the same catch-up owner; it does not append another backlog page first. This ordinary catch-up merges cached history rather than discarding it. Detached readers still load one adjacent page on explicit forward-edge demand. This uses the source's existing page budget, not a second UI page ceiling; ordinary no-work tail probes do not raise the catching-up indicator.

The existing tail-discontinuity owner represents both hosted sequence gaps and direct opaque-cursor gaps. Direct continuity is established by original source-row overlap, never timestamps or displayed tool identities. The same transcript projection keeps the connected suffix visible with the existing “Earlier messages” separator, while retaining disconnected older rows in the cache. Normal older-edge loading walks from the latest island into the hole; after overlap it resumes the preserved pre-gap older cursor. Stacked jumps retain the deepest prefix, and terminal exhaustion stops network requests without pretending that an unbridged gap became contiguous.

Within the main transcript, initial-fill and jump reads report exhaustion to the existing older-pagination machine rather than retaining a separate component flag. A later fillable tail gap can reset an exhausted pager; that reset alone does not fetch a page or move the viewport. If bounded initial fill leaves the main transcript too short to scroll, “Earlier messages” lets the reader request one page through that same pager and prepend path. It does not restart automatic fill or use the main cursor inside a target window. Sidechain and public transcript lists retain their dataset-scoped pagination lifecycles.

An older-page response is admitted only while the accepted transcript window that requested it still exists. Ordinary tail growth preserves that window identity; source reset or replacement retires it, so a held response cannot reinsert rows from the replaced source even when cursor strings are reused. Forward reads and staged snapshots also check their request-start cursor so they cannot overwrite a newer accepted tail.

Claude's file cursor records the consumed JSONL boundary, not an arbitrary file size: a partially written terminal record remains readable when the writer completes it. The existing bounded file pager supplies that boundary for snapshots, tail initialization, and source-reset recovery. If the existing read budget cannot establish the boundary, the read fails rather than publishing an unsafe cursor. A page budget and an incomplete terminal line are distinct outcomes.

## Implementation references
- API routes: `apps/server/sources/app/api/routes`
- Socket handlers: `apps/server/sources/app/api/socket`
- Event routing: `apps/server/sources/app/events/eventRouter.ts`
