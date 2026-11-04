# Protocol

This document describes the Happier wire protocol as implemented in `apps/server`. The protocol is intentionally small: JSON over HTTP for reads/actions and Socket.IO for real-time sync. Persisted content uses explicit plain or encrypted domain representations; see `encryption.md` for mode, key-ownership, and encoding boundaries. For the full HTTP surface and auth flows, see `api.md`.

## Transport and versioning
- HTTP API: JSON requests/responses on `/v1` and `/v2` routes.
- WebSocket: Socket.IO server at path `/v1/updates` (transports: websocket, polling).
- CORS: `*` (server-side).

### API response compression (0.3 development)

The API composition negotiates Brotli or gzip for eligible responses through
`enableApiCompression`, retaining the plugin's 1 KiB threshold, Brotli quality 4
and gzip defaults. Requests are not automatically decompressed. Identity and
already encoded responses retain their existing representation; JSON and stored
content envelopes are unchanged.

Static UI sidecars and Engine.IO at `/v1/updates` keep their own encoding owners.
Local-service preview responses hijack Fastify's raw reply and stream directly.
The external Provider API opts out at its route owner with `compress: false` so
JSON chunks remain incremental; other incremental API routes must choose that
same explicit opt-out rather than inherit buffered compression behavior.

### UI recovery read lifetime (0.3 development)

The HTTP request owner retains read cancellation through response consumption,
including captured Home/Account requests and read-only POST operations. Web reads
use an inactivity window, reset when nonempty body chunks arrive, rather than a
total transfer deadline. The default is the server peer-liveness window (15s ping
interval plus 45s timeout); `EXPO_PUBLIC_HAPPIER_SERVER_READ_INACTIVITY_TIMEOUT_MS`
can override it with a positive timer-safe millisecond value. Timeout activation
is logged without request content or credentials.

Native fetch may expose no progress until the whole response arrives. Only
owner-declared server-bounded pages acquire a deadline in that phase; large,
unpaged reads remain cancellable without a total deadline. Read recovery never
opts mutations into cancellation or retry. HTTP readiness remains independent of
socket-only failures: the socket transport retains its own managed retry demand,
and suspends dialing when HTTP reachability is genuinely unavailable.

Manual Retry cancels outstanding recovery reads and releases only the incumbent
resume's queue waiters, including waits parked in backoff or snapshot repair.
The incumbent settles through its original dedupe owner before a fresh manual
resume enters. The existing manual-generation and scope guard retires queued
apply actions and later snapshot phases; a retired apply supplies no safe cursor.
InvalidateSync retains its autonomous cycle, serialization and existing backoff.
A superseded in-flight read is replaced within that cycle without consuming its
failure budget or adding backoff. Issued mutations and user-request leases remain
intact; configuration retirement and other hard boundaries keep their existing
behavior. This describes 0.3 development source.

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

## Plaintext message storage (development)

Before comparing or storing plaintext message envelopes, the server removes actual
NUL characters (U+0000) from string values, including nested tool output. PostgreSQL
JSONB cannot represent NUL. Literal text such as `\u0000` and other control
characters remain unchanged. Transcript, historical-import and pending-message writers
share `normalizeSessionMessageContentForStorage`; retries compare the normalized
content. A fixed `nul-removed` warning records normalization without message data.
NUL-bearing object keys and ciphertext are rejected: rewriting
keys could merge distinct fields, and encrypted content is opaque. This correction
is development source behavior; release availability is tracked separately.

## Authentication
Most endpoints require `Authorization: Bearer <token>`. The same token is also used in the Socket.IO handshake. Full auth flows and endpoints are documented in `api.md`.

## Session awareness (development)

The development implementation in `packages/protocol/src/sessions/awareness` owns
the derived operational meaning of Session lifecycle, runtime activity, freshness,
pending input, work state, and content availability. Host adapters normalize existing
authorized Session facts and content-opening results into its pure projector. The
projection is not persisted and does not own unread state, following, personal
attention, or notification decisions.

The shared presentation keeps a completed, operationally ready worker settled
after its publisher stops, goes offline or its observation becomes stale. The
process-terminal fact remains separate. Current requests, explicit resume and
runtime serviceability failures retain precedence; List, Map and report counts
consume the same decision.

Pending permission and user-action counts are session-wide projections of the
acknowledged Agent state. Its legacy and metadata-tuple writers normalize and
publish those counts, including explicit clears when requests settle. Foreground
turn completion, publisher close, and released-UI Stop preserve them: a background
Agent or an occurrence-scoped question can still await an answer after the latest
turn ends. Turn status and Runtime Activity keep their separate lifecycle owners.
These are current 0.3 development source semantics, not a release availability claim.

UI tuple admission keeps Agent-state content and public pending projections on the
same accepted revision, using the canonical Session tuple currentness owner and
its metadata privacy-contraction rules. An older payload cannot restore pending
flags after settlement clears the observation timestamp. Metadata remains
independently versioned. Cache-only public updates retain their envelope version
without claiming encrypted detail has been decrypted; newer hydrated request
flags can settle independently of newer metadata. Composer status observes the
canonical pending flags so transcript-only settlement reaches a mounted composer.

The `session.list` Action keeps its default summary response. An explicit
`view: 'awareness'` request requires a response carrying both `view: 'awareness'`
and `projectionVersion: 1`; an unmarked response from a host that ignores the option
produces `awareness_view_unsupported`. Awareness reads do not fetch transcript
previews. A request containing the strict `query` input requires `queryVersion: 1`
on either summary or awareness output; a passthrough predecessor that silently ignores
the query produces the operation-scoped `session_list_query_update_required` failure.
Filtered lists retain the server's ordinary and attention continuation fields
separately, and a marked awareness result may carry both paired continuation families.

The development `SessionListQueryV1` accepts optional `folderIds` beside
`tagIds`. Each selector matches any supplied id in the viewer's own assignments;
supplying both combines them with AND. Folder selection is exact membership,
not a descendant walk. An unknown id matches no assignment. Existing access,
storage, audience, attention and cursor predicates still apply.

In 0.3 development, a focused client ignores a Session-only advisory wake when
every named Session already applied that exact Account cursor and the wake
explicitly excludes System-record changes. This does not advance the durable
feed cursor: an uncovered wake or reconnect still consumes the history. Missing
routing facts, mixed kinds and record changes retain catch-up. Home catalog
relevance comes from the existing change planner, so known Session traffic does
not widen into Settings, Profile or Workflow catalog refreshes.

Metadata writers that publish a committed current view retain the durable
change row and send its advisory wake only to sockets outside that current-view
audience. Machine sockets and other Session sockets retain their wake; layout-0
shared recipients do too because flat private metadata is owner-only. Mixed
transaction wakes remain conservative. A failed current-view projection wakes
its recipients for ordinary cursor recovery. Writers without a current-view
publisher, including historical import, keep the ordinary wake.

**Lane 07 correction in progress (0.3 development):** the server's optional
nonnegative `metadataUpgradeRequiredCount` must survive the existing summary and
awareness result contracts through UI, CLI, Actions and SDK consumers. A positive
value means historical rows were withheld because their metadata needs upgrading;
readable rows remain usable. Counts accumulated across overlapping page families
describe omission occurrences, not a deduplicated total of missing Sessions.
Pagination exhaustion and corpus completeness are separate: when both cursor
families are drained but rows were withheld, the UI shows the historical-share
recovery explanation rather than an endless Load more affordance. Neither a mounted
list nor an off-pane Voice corpus may establish absence or uniqueness within its
intended corpus from those incomplete candidates. Propagation and completeness
corrections remain under implementation and validation; this paragraph does not
assert released availability.

The optional summary-preview path remains separate. The existing
`session.activity.get` Action adapts the same projector to its compatibility result.
That adapter derives its operational booleans from awareness and passes host-observed
ancillary facts through verbatim. Ancillary facts the responding host cannot observe —
retained-window message counts, and permission request identities on a host that reads
pending counts only — are omitted rather than reported as an empty or zero value.
It accepts the same `view` selector in its canonical form hints: omitting it keeps that
released digest, while `view: 'awareness'` answers with the canonical projection itself.
The projection's own `v: 1` is the marker there, so a host that ignores the option and
returns its digest produces `awareness_view_unsupported` instead of a false success.
`view: 'awareness'` cannot be combined with `windowSeconds`, which only narrows the
released retained-window counts that awareness does not carry.
CLI Session status retains its existing Session and Agent-state fields and adds
optional awareness. Its live adapter includes freshly decoded pending-request
evidence before projection; it does not introduce a separate awareness endpoint.

Session identifiers in these results are Home-local. Multi-Home consumers retain
the selected Home through the existing qualified Session address. Server access and
recipient projection precede host awareness projection; missing content-opening
evidence must not turn encrypted content into plaintext or imply key delivery is in
progress. The existing projection preserves access pending, recipient setup required,
repair required, and content unavailable when the content owner supplies those facts.
Absent availability stays unknown; cached metadata does not establish readiness.
`preparing` requires actual preparation in progress. Private title, work, lineage,
and workspace fields remain absent unless content is plain or known ready.
These development contracts do not establish released availability.

## Session changes (0.3 development source)

`GET /v2/changes?after=...&sessionId=...` filters the existing Account change
page to `session` and `share` rows whose `entityId` is that exact Session.
`nextCursor` is computed from the raw Account page, including when the filtered
page is empty. Consumers must checkpoint that cursor rather than the last
visible row. The existing retention/future-cursor and post-read retention checks
still return `410 cursor-gone`, requiring a snapshot rebuild.

`sessionAccessSessionId` remains the separate exact-access probe. Supplying it
together with `sessionId` returns `400 invalid_params`; filtering does not create
a second access or token-admission owner.

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
  - `body`: `{ t: "new-session", id, seq, metadata, metadataVersion, agentState, agentStateVersion, dataEncryptionKey, encryptionMode?, active, activeAt, createdAt, updatedAt, currentStorageState? }`
  - `currentStorageState` (additive, optional): the Session's persisted storage state (`hosted`, or `machine_only` for an
    external-session import). Clients choose the transcript reader from it; a body without it (released servers) keeps the
    client's existing fallback.

- `update-session`
  - `body`: `{ t: "update-session", id, metadata?, agentState? }`
  - `metadata`: `{ value, version }` or null
  - `agentState`: `{ value, version }` or null

- `delete-session`
  - `body`: `{ t: "delete-session", sid }`

- `new-message`
  - 0.3 development `body`: `{ t: "new-message", sid, delivery: "full" | "hint", message }`. `message-updated` uses the same delivery arms.
  - `full` carries the existing complete message row. `hint` carries only message identity, sequence, timestamps, optional role/sidechain/source provenance, and required attention impact. It contains no content, actor profile or delivery-resolution detail.

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

### Session content consumption (0.3 development)

UI sockets with purpose `sync` or `concurrent-server-cache` replace their own current
content demand through `session-consumption-replace`:
`{ v: 1, liveSessionIds: string[], durableSessionIds: string[] }`. The response is
`{ ok: true, v: 1, liveSessionIds, durableSessionIds }` with admitted ids, or
`{ ok: false, error }`. Both envelopes are closed. The server admits requested ids
through the socket credential's current `readTranscript` decision; an omitted id
does not distinguish absence from denied access. Interest never grants access.

`sessionLiveConsumption` is the sole UI demand producer. Visible transcripts,
explicit content panes, active Voice and the mounted SCM Session consume live
content. Hidden same-project SCM consumes durable bodies without live stream
segments. Retention-only back-stack surfaces do not request content. Declarations
are local to the socket, resent on reconnect, and discarded with that connection.
Retained Voice focus and primary-action targets count only while Voice can stop
an active attempt. A refused or partial declaration logs a warning on either
Home transport without changing connected status; demand changes and reconnects
remain the re-declaration triggers.
`ui-focus` and human-presence declarations retain their separate meanings.

After existing recipient/publication admission, each receiving API node uses the
shared Protocol delivery classifier with its local socket's demand. Live consumers
receive complete durable rows, checkpoints and deltas. Durable-only SCM consumers
receive complete durable rows and no stream segments. Other UI sockets receive
durable hints and no stream segments, including before their first declaration.
The UI's pooled `scoped-rpc` sockets also receive hints without stream segments;
they carry RPCs and do not declare transcript demand.
Session-scoped runners/SDK followers and existing non-UI user-scoped carriers retain
full delivery. Existing Machine exclusion and sender suppression remain unchanged.
Redis forwards protected routing intent; it does not hold a second interest map.

Hints update scalar list facts and known remote sequence, and retain deferred append
or exact revision-repair markers. They never decrypt, materialize a transcript row,
advance its received-row watermark, or acknowledge a changes page. After admitted
live demand, the UI uses its existing exact-shell and transcript catch-up owners;
a late hint also invalidates that consumer's existing repair owner. Secondary Home
hints patch only their qualified row and read unknown rows through the existing
exact reader. Actual secondary content demand enters the same transcript/SCM owner
with that Home's captured request authority and cipher. Delayed content and hint
markers cannot cross into another Home's same-id full carrier. Rebinding that
single full carrier to a different known Home retires its old transcript state;
same-Home refresh and revision repair preserve older pages. A live stream without
an accepted checkpoint drops deltas until a
later checkpoint; paused publishers have no promised periodic checkpoint.

This is canonical unreleased 0.3 wire behavior, with no feature gate or mixed
0.2/0.3 component support. Stored message/metadata/key formats are unchanged, so
0.2-created data continues through the existing readers and migrations. This
section does not certify loaded-runtime or deployment validation.

### Ephemeral event types
- `activity`: `{ type: "activity", id: sessionId, active, activeAt, thinking? }`
- `machine-activity`: `{ type: "machine-activity", id: machineId, active, activeAt }`
- `usage`: `{ type: "usage", id: sessionId, key, tokens, cost, timestamp }`
- `team-credential-usage-changed`: `{ type: "team-credential-usage-changed", resourceId }` — content-free wake sent to the app (user-scoped) connections of a Team credential resource's usage readers (active custodian, credential managers, and the acting member) after a new immutable usage fact for that resource commits. Idempotent replays do not emit it, daemons do not receive it, and readers re-query the authorized resource usage projection.
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
  - In the current development server, the released event refreshes the exact machine-bound publisher's reachability. The server uses its receipt time, retains observations while coalescing writes, and does not derive runtime activity from the legacy `thinking` flag. See [presence ownership](backend-architecture.md#presence-and-activity).
  - Committed reachability is projected through the Session transcript publication policy to interested recipients, with an additional activity `ephemeral` event to the publisher's user-scoped connections.

- `session-end`
  - `{ sid, time }`
  - Closes the authorized publisher and publishes its inactive state through `publishSessionPublisherClose`, using the same recipient policy and user-scoped activity fanout.

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
  - In 0.3 development source, rejection emits `rpc-error` with
    `{ type: "register", error, method?, retryable }`. `method` is the validated
    registration name; malformed names are omitted. The server alone classifies
    static namespace/scope refusals as non-retryable, while current authority,
    Machine availability, and internal failures remain retryable.
  - The CLI suppresses registration replay after an explicitly non-retryable,
    correlated rejection within the current relay connection. Each new connection
    clears that suppression and submits the handler for fresh admission; explicit
    handler replacement also clears it. Missing correlation or retry classification
    retains ordinary retry behavior. Rejection logs contain only known method
    names and bounded error labels, not arbitrary server response fields.

- `rpc-unregister`
  - `{ method }` -> server emits `rpc-unregistered`

- `rpc-call`
  - `{ method, params }` -> callback `{ ok, result? | error? }`
  - Server forwards to the registered socket via `rpc-request` (ack-based).

## Session creation directory intent (planned 0.3 development behavior)

The approved folderless-session contract is being implemented on the unreleased
0.3 development line. The shapes and lifecycle below await integrated verification;
they do not assert live or released availability.

`SessionSpawnNewInputV2Schema.directory` and its server-start draft will carry one
strict `SessionDirectoryIntentV1` union:

```ts
type SessionDirectoryIntentV1 =
  | { kind: 'path'; path: string }
  | { kind: 'managed' };
```

`path` is a trimmed, nonempty path. `managed` requests a daemon-owned private
working directory without choosing its path. Missing/empty directory and a bare
string have no implicit managed meaning. `checkoutCreationDraft` is valid only
with `kind: 'path'`. This replaces the unreleased string input in place; it is
not a second directory field. Machine selection remains required.

Creation correspondence compares the intent. Allocation identity comes from the
existing namespaced `sessionCreationTag`; preparation and existing-session rejoin
must not materialize or rebind a folder. The target daemon alone resolves,
protects and materializes it on fresh spawn. See
[managed directory ownership](./cli-architecture.md#managed-session-directories-planned-03-development-behavior).

Owner metadata retains a real `path` for machine RPC and adds the optional strict
`sessionDirectoryV1: { v: 1, kind: 'managed' }` marker. The Protocol classifier
`readSessionDirectoryKind` owns interpretation for presentation and resume routing.
Absent or malformed markers retain ordinary path-session behavior, including
released 0.2 session data. The marker never establishes filesystem ownership;
only the daemon's local owner record can do that.

Retained folder data can use `{ t: 'managedSessions', serverId, machineId }` in
`SessionFolderWorkspaceRefV1` for one machine's Chats scope. Current 0.3 Account
sections use the existing folder records without a workspace restriction; private
per-session paths still do not become Projects or recent paths. The
[section Action contract](actions.md) preserves these historical identities and
assignments while keeping the released folder HTTP DTO vocabulary.

A missing or unproven managed directory produces `SESSION_DIRECTORY_MISSING`
without silent recreation. Explicit user consent reuses the resume request's
`approvedNewDirectoryCreation` bit to continue in an empty private folder. Queued
input stays queued until that choice. Durable session deletion drives daemon
cleanup; archive retains the directory, and offline removal remains pending until
reconnect. No managed-folder registry or cleanup timer is added on the server.

Managed handoff uses a daemon-private `{kind:'managed'}` target directive: the
target allocates under its own root rather than interpreting a source path.
Workspace bytes travel through the existing seed transfer without WorkspaceRef
enrollment. Managed directories do not establish a sandbox or restrict an
Agent's OS-user permissions.

## HTTP endpoints by area
See `api.md` for the full HTTP endpoint catalog and auth flows.

## Sequencing and concurrency
- `UpdatePayload.seq` is the per-user update sequence (monotonic) used for sync ordering.
- Sessions, machines, and artifacts have their own `seq` fields used by clients for ordering.
- Versioned fields (metadata, agentState, daemonState, artifact header/body, access keys, KV) use optimistic concurrency with `expectedVersion` and return a version-mismatch response containing the current version/data.

### Hosted transcript catch-up and reading position (development)

This 0.3 integration is in progress, not a released guarantee. The hosted catch-up, page-pipeline, viewport-demand, retry, realtime-gap, and sparse-repair behavior described below is present with focused owner coverage; integrated and live validation remain incomplete.

Account-change cursors, Session sequence hints, and transcript paging cursors serve different purposes. A Session hint announces durable content but does not prove that this device has loaded intervening rows. An account checkpoint can advance after successful shell/content handling when the UI retains outstanding forward loading in its canonical deferred-transcript state. Failed shell loads, message loads, and revision repairs still block the affected checkpoint.

In current 0.3 development source, an absent Account-change checkpoint starts
snapshot repair instead of replaying change history from zero. Repair captures
the current cursor before starting its materializing reads. List invalidation
drains an older acquisition and awaits a fresh cycle under the existing resume
wait budget; a stopped, expired, failed, or retired repair cannot seed the
checkpoint. A completed repair is reused by the resume tail. If the app becomes
backgrounded during resume, that attempt stops issuing HTTP work and the next
foreground transition owns catch-up. These source contracts still require the
integrated and loaded-runtime checks described above.

Required Session rows gather through the existing `/v2/sessions/read-batch`
owner, including pins discovered while an ordinary list read is in flight.
Returned compact IDs alone do not prove required readable materialization.
Only recognized exact absence authorizes local retirement; an unrecognized
404 remains a failed read and cannot authorize a checkpoint.

`decideMessageCatchUpPolicy` owns hosted catch-up. Its existing defaults allow three incremental pages, with a separate large-gap threshold of 500 sequence positions and a long-offline threshold of 30 minutes; sequence positions are not necessarily main-transcript rows. Large backlogs go directly to the latest page for live-tail readers and remain deferred for history readers. An explicit reopen can probe one page even when the Session hint appears current. Known deferred backlog takes precedence over a stale hint.

Latest-page catch-up merges into retained history and records omitted ranges through the tail-discontinuity owner. It does not clear cached history. Current viewport intent is checked again across asynchronous work: a reader who detaches or enters a target window must not acquire a live-tail display floor from an outstanding response.

Visibility does not imply bottom arrival. Detached forward-edge paging retains one-adjacent-page behavior, target-window proximity uses only that window's cursors, and explicit live-tail demand returns to the canonical catch-up policy. An unsuccessful catch-up read retains deferred demand, so a stale Session hint cannot suppress the needed retry.

Within the main transcript, initial-fill and jump reads report exhaustion to the existing older-pagination machine rather than retaining a separate component flag. A later fillable tail gap can reset an exhausted pager; that reset alone does not fetch a page or move the viewport. If bounded fill leaves the transcript too short to scroll, the existing “Earlier messages” action requests one page through the same pager and prepend path. Explicit continuation clears the automatic negative-offset suspension, but preserves fill and viewport-transaction suspensions. The main-transcript action is unavailable inside a target window, which retains its own cursors. Sidechain and public transcript lists retain their dataset-scoped pagination lifecycles.

The shared message-page pipeline preserves Session/owner and encryption currentness fences. Successfully normalized rows can be retained even when another row cannot be decrypted, but the page does not publish pagination coverage across that unresolved row. Received revision watermarks follow successful reducer application. Cryptographic authentication failure remains distinct from authenticated unsupported or null content.

Live socket rows, including sidechain rows, remain visible while canonical deferred-transcript state retains the earliest uncovered sequence cursor and observed upper bound. Hosted incremental catch-up and adjacent forward paging read that gap floor, including zero for an already-loaded empty transcript. Only successful page commits advance coverage; a latest snapshot transfers omitted history to the existing tail-discontinuity owner. The shared acknowledged-message commit path detects gaps from locally acknowledged messages as well.

Sparse repair uses bounded affected ranges identified by message identities and available sequence hints, rather than replaying between distant edits. Each group uses the configured page size and may refresh already-materialized neighbors without inserting unseen, unrequested spill rows; only explicitly hinted rows receive authoritative replacement semantics. Repair suppresses historical lifecycle events without changing target-window or forward paging cursors, and missing or unavailable rows remain outstanding. Completion acknowledges the captured immutable stale-message map, retaining newer marks that arrive during the request. Account-change hints are coalesced per Session and retain only the latest hint, not a complete edit journal, so bounded repair cannot certify the freshness of every historical row outside the fetched ranges.

### Personal Machine Pool changes (0.3 development)

`machinePool` is an additive known `AccountChange.kind`. Each committed Pool
definition mutation advances the existing Account change cursor with the Pool ID
as `entityId`; the event is an invalidation, not a second copy of the aggregate.
Current clients refresh that exact Home's Pool repository through the six
`machines.pools.*` Actions. Initial load and reconnect also fetch the canonical
projection. Ordinary Machine updates can change observed member availability
without changing the saved Pool revision.

The current client declaration is stored-content protocol `4`, which includes the
additive `machinePool` kind. The server withholds this kind from missing, malformed,
and pre-v4 declarations while still advancing through the raw Account-change page.
This preserves older clients' ability to consume the open-ended change feed without
teaching them Pool semantics.

The Pool wire schemas live in `packages/protocol/src/machines/pools/v1.ts`. A
`MachinePoolViewV1` separates the saved definition from observed availability.
Member state can be `connected`, `offline`, `revoked`, `replaced`, `temporary`, or
`unknown`; an unavailable observation is not rewritten as offline. Pool-level
availability is the separate `{ state: 'known', connectedCount, enabledCount }` or
`{ state: 'unknown' }` union, so a Home that could not read its Machine sockets
reports unknown rather than a false zero. Resolution selects the lowest numeric
tier holding an enabled, connected member and orders equal-tier candidates by a
deterministic hash of `[requestKey, machineId]` with the Machine ID as the final
total-order tie-break; it returns only a Home-local Machine ID and tier (or the
typed `empty` / `no_available_machine` / `presence_unavailable` result). The
consuming client combines it with its captured `serverId` and uses the existing exact
`SessionExecutionTargetV1` contract. Supporting current components may also carry
the strict informational origin `{ kind: 'machine_pool', poolId }` through the
versioned Machine authoring arm and optional `placementOrigin`. It contains no name,
membership, request key, candidate list, or authority, and is omitted before first
dispatch when the negotiated Machine-operation compatibility projection does not
positively support it. The exact target remains authoritative; Pool selection policy
does not enter the daemon/session spawn protocol.

The corresponding user intents are exactly `machines.pools.list`,
`machines.pools.get`, `machines.pools.create`, `machines.pools.update`,
`machines.pools.delete`, and `machines.pools.resolve`. They form one Action family
over the authenticated Home-local routes. Create carries a caller-minted Pool UUID
for response-loss replay; update and delete carry the loaded aggregate revision.
There is no per-member Action, Pool-shaped execution target, persisted selection,
or portable retry target.

Feature skew is additive. A client calls this family only when the exact Home
positively publishes `machines.pools`; missing or malformed support disables the
family while leaving exact-Machine authoring and spawning intact. Stored-content
protocol v4 peers can receive `machinePool` invalidations. Older peers advance the
same Account-change cursor without receiving that known kind and reconstruct no
Pool state from it.

`connected_pool` in the Team credential source schema means a Connected Service
Pool. It is not a `MachinePoolViewV1` and cannot be used as an execution destination.
Credential-resource placement is the closed exact-Machine or `machine_pool` union.
For a genuinely new Pool-backed open, the source-owning daemon reports content-free
eligibility across the currently available candidates, the Home applies the same
canonical Pool selector once, and the existing broker path pins the resulting exact
Machine before signing route authority. Ordinary Sessions, Resource Test/catalog,
and restricted Runner activation consume this path in current 0.3 source. It remains
development-only, with integrated package and loaded-Provider validation open.

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

In 0.3 development, owner and shared-editor metadata tuple writes may publish
the closed `sharedActionConfirmationSummaryV1` permission-count facet beside
the shared ciphertext. It is committed atomically with that shared metadata
version into the Session summary, independently of the owner's Agent-state
counts. Omission preserves the contribution; explicit zero settles it. A
rename-only shared write cannot publish this facet. The personal-attention
owner combines both contributions and applies the viewer's approval grant;
the facet grants neither approval rights nor owner-metadata access. Existing
0.2-created Sessions start with a zero contribution. This is an unreleased
layout-1 contract change, not a mixed-0.3-version or rollback representation.

Current unreleased 0.3 development source treats a Bot as an ordinary Session with
a reversible owner `work.bot: { kind: 'bot' }` marker and recipient-safe shared
`bot` projection. Its optional shared-only `botFace` contains deliberate cosmetic
overrides: style, body, palette colour, seed and an optional version-1 `shape`.
The shape carries closed fill paths, optional round-capped `[path, width]`
strokes, optional fill/stroke cuts, and a `[x, y, scale]` mouth anchor. Its
optional `origin` is `custom` or `surprise`. Shape takes precedence over body in
Dither, Solid, Pixel and Dots. Planet always uses the standard planet with the
Bot's palette and mouth, ignoring body and shape art. The body remains the
fallback for readers without custom-shape rendering. Generated
faces store their concrete outline, so generator changes cannot alter saved art.
`BotFaceBodySchema` contains the
34 Round-3 roster ids shipped by R6; `BotFacePaletteSchema` owns colour choices.
Solid uses matte, and there is no configurable finish field.
`SessionSharedMetadataV1` and `SessionSharedDisplayV1` carry both fields to
authorized viewers; the face adds no private `work` field. The immutable creation
fact `work.createdAsBot: true`, memory choice and
`work.viewPreferences.showToolCalls` remain owner-private. The local
compatibility view exposes `bot`, `botFace` and `createdAsBot` flat and retains
other private fields under `work`.
Stored owner/shared reads recursively discard unknown extensions and validate known
fields through the canonical stored-read projection. Creation, Actions and writes
still use strict admission schemas. No separate Bot entity or runtime is introduced.

In that development source, transcript visibility resolves an explicit Session
`showToolCalls` choice first, then the Bot-hidden default, then the Account
`transcriptShowToolCalls` preference (default true). Setting the Session choice to
null clears its override. These are human view preferences, not Agent runtime
instructions. Hidden tool calls use the existing collapsed group without previews;
permissions, pending questions and failures remain visible. Main and Chain app
transcripts share the existing live work-state/freshness subscription and compact
status/elapsed presentation. A show-to-hide transition clears local expansion
through the existing viewport-preparation seam; revealing a group is local only.

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

## External transcript continuation (development)

External transcript refresh follows the reader's current intent. A loaded transcript
that is detached from the live tail, including a target-window view, retains its
accepted rows and reading position. Automatic refresh defers content work there;
explicit forward-edge demand can request one adjacent page through the external
transcript RPC. Foreground resume only refreshes loaded Sessions with a current
full-content consumer.

Protocol's `shouldResyncExternalSessionTranscriptReadAfterV1` owns the continuation
decision. An advancing page with `hasMore` may be appended for explicit adjacent
paging, but live-tail demand fetches and merges a bounded latest page while
retaining cached earlier history. The existing tail-discontinuity owner records
an opaque-cursor gap, and the transcript's earlier-messages separator pages from
the latest island until a source-identity overlap reconnects the cached prefix.
Then the original older cursor resumes. Stacked gaps retain the deepest prefix;
network exhaustion keeps the separator rather than claiming continuity. Source
page receipts are distinct from rendered row IDs, so absorbed tool results can
prove overlap without falsely exposing an old tool row. A later visible message
initializes an empty display boundary without advancing or closing the gap.
A stalled
cursor or required source diagnostic still requires authoritative recovery, not a
merge into accepted history. The accepted cursor's existing state retains an
observed discontinuity until replacement succeeds, including when a source
regrows enough for that old cursor to look valid again. Forward, older-page, and
secure-refresh reads share this recovery intent; a changed source authority
retains its separate binding fence. Reads admitted before a reset cannot append
after replacement, even if cursor strings are reused; ordinary tail growth
leaves older-history reads valid. Forward and latest-window reads also require
their original cursor to remain current. A staged latest window cannot overwrite
a newer accepted window. Genuine source replacement is staged before commit and rechecks the
viewport: a failed fetch or a reader who detached during the request keeps the
last accepted transcript. Secure refresh retains its existing source-binding and
generation checks; this paging policy does not relax them.

Transcript authority, not the presence of a retained external link, selects the
transport. Once a Session is hosted, that retained link does not suppress ordinary
server catch-up or route forward paging back to the external source. The shared
HTTP page-currentness predicate captures this authority alongside Account, server
and encryption currentness. Superseded HTTP reads cannot publish rows, mark a
transcript or sidechain loaded, acknowledge repair demand, or update paging state
after a handoff. Source replacement remains staged through the existing authority
owner; a failed replacement read preserves the accepted transcript.

The current `../0.2` predecessor's direct transcript RPCs add optional
`truncationReason` while retaining its released `truncated` boolean. Only the
existing legacy RPC response adapter translates those facts: `page_limit` clears
the overloaded truncation flag, establishes `hasMore` for read-after, and preserves
the page RPC's own older-availability and cursor. `source_discontinuity` remains
truncated and becomes a required source diagnostic. The
current 0.3 protocol adds no parallel reason field. Released responses without the
reason keep their conservative truncation semantics, and a clean empty
already-current response retaining its cursor stays a no-op. Only the initial
`tail` bootstrap may be clean-empty without a cursor; an ordinary read losing
its accepted continuation requires recovery. This adapter follows the prospective
predecessor contract owned by `packages/protocol/src/directSessions/daemonRpcV1.ts`;
it is not a second continuation policy.

Claude's existing V3 source anchors remain Agent-owned. Latest-page and tail cursors
stop at the consumed complete-record boundary, so an unfinished JSONL record can
be read after its append completes. Bounded forward reads report `hasMore` when
their existing page budget leaves work; incomplete EOF alone does not report a
page-limit backlog.

## Implementation references
- API routes: `apps/server/sources/app/api/routes`
- Socket handlers: `apps/server/sources/app/api/socket`
- Event routing: `apps/server/sources/app/events/eventRouter.ts`
