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
  - In development source, cache-only socket updates apply envelope timestamp/sequence ordering only to unversioned row fields. Lifecycle, request and metadata facts reach their shared reconciliation owner even when the row already has a newer general timestamp: runtime activity uses its revision, turn status its observation time, and ready state its cursor. List patches and replacement snapshots derive unread state after reconciliation, including when an older metadata read is rejected. Missing transcript evidence cannot clear previously proven unread on its own; accepted read-cursor advances still take effect. This prevents unrelated row activity from suppressing completion while retaining stale-field protection; it adds no timeout-based retirement or wire fields.
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

Independent sessions started by the `session_agent` surface of `session.spawn_new`
carry optional protocol-owned metadata
`sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId }`. The action's execution
context supplies the creator, never tool arguments, a title, a path, or `forkV1`.
Replay-seeded creation includes it in the initial metadata; ordinary daemon
creation persists it through the existing versioned metadata writer before the
action returns. Startup and resume preserve an existing origin. Missing,
malformed, or unsupported origin means unknown. There is no historical backfill.
`forkV1` remains transcript ancestry and confers no creator identity.

The sidebar derives automatic parent placement from that origin only when the
creator is an accessible, unarchived session on the same server. Account appearance
display content can separately carry `placement: { kind: 'session', parentSessionId }`
or `{ kind: 'topLevel' }`, and `identity: 'independent'`. Explicit placement wins
over automatic origin; explicit pins and folder assignments win over both. Invalid,
self-linked, cyclic, missing, filtered, or cross-server parents leave the child
discoverable at top level. The row and native context menus show one placement
command near the bottom, just above the lifecycle actions: a top-level row offers
**Nest under…**, which opens the existing session selector and writes only manual
placement (so coordinator-created siblings can be organized without inventing creator
provenance); a nested row offers **Make standalone**, which writes only
`placement: { kind: 'topLevel' }`. To change parents, make the row standalone and nest
it again. Each edit merges only its own display fields, retaining color, identity, and
unknown display data. Search does not hide matches behind collapsed session parents.
Section, project, and folder collapse apply after parent placement: a nested row follows
its parent's visibility, so a pinned parent keeps its own child disclosure and children
while their original date section is collapsed. Drag-and-drop nesting is deferred
owner scope.

Sessions can also carry an explicit, mutable role in protocol-owned metadata
`sessionRoleV1: { v: 1, role: 'planner' | 'project_lead' | 'worker' | 'reviewer' | 'delegate' | 'custom:<uuid>', name?, color?, instructions, assignmentId, assignedAt }`.
A new assignment offers Planner, Project Lead, Worker, and Reviewer. `delegate` remains a readable
legacy identity only: it is not silently mapped to Worker or offered for new assignment. Existing
Planner and Delegate snapshots, including their exact instructions, remain authoritative until an
explicit reassign, reapply, or clear. Account role catalogs can also contain first-class custom
identities with stable generated `custom:<uuid>` ids, editable display names, instructions, and
opaque `#RRGGBB` badge colors. A custom assignment snapshot requires and retains its name and color,
so a deleted profile remains correctly named, colored, and prompt-resumable in running and historical
sessions even though it is no longer offered for a new assignment.
A role can be assigned, reassigned, reapplied, or cleared at any time without forking. It never
changes permission mode, provider/model, control or ownership, creator or fork provenance, manual
placement, nesting, pins, folders, avatar, session-appearance color, or title, and it is never inferred from a title,
provider, agent-started state, nesting, or delegation. `instructions` is the exact snapshot
resolved when the role was assigned: account-wide **Role profiles** (Settings > Sub-agents, account
setting `sessionRoleProfilesV1`, separate from `executionRunsGuidanceEntries`) supply one optional
override per role over the built-in defaults, and editing them never rewrites an existing
assignment. The snapshot is a verbatim copy of an admitted account-settings value, so it adds no
separate size limit. Missing, malformed, or unknown future role data reads as no role guidance. A
syntactically valid custom id is readable only with its self-contained name and badge-color snapshot.
Existing legacy/custom instruction keys and unknown passthrough fields remain in the v1 settings
object through unrelated edits. New defaults affect only a future assignment or explicit reapply;
there is no settings or active-session migration. The four current built-in ids and names are
stable: this v1 setting edits their instruction and badge-color overrides but does not rename or remove them;
a display alias changes only their labels (below).
Legacy `delegate` overrides remain readable and round-trip even though `delegate` is not offered
for a new assignment. `sessionRoleProfilesV1.customRoles` owns the custom catalog. Editing a custom
profile affects future assignments and an explicit reapply only. Removing one deletes only that
catalog entry; it never rewrites, clears, renames, reassigns, or re-messages an existing session.
Adding, editing, or removing one profile preserves unknown top-level and per-profile fields.

An optional `sessionRoleProfilesV1.displayNamesByRole` gives a built-in role (`planner`, `project_lead`,
`worker`, `delegate`, `reviewer`) a display alias for badges and labels. It is presentation only and
absent by default. Agent-facing names never read it: the role snapshot carries no alias, so
`Role assignment:`, `Current role assignment:`, and `Current run role:` keep the canonical built-in
name, and a visible run's role echo keeps the profile's canonical `name`. Changing an alias rewrites
no session and queues no instruction. A malformed alias reads as absent without discarding the rest
of the profiles. Custom roles have no alias; their own `name` is already the label.

Role profiles always come from the target session's own server and account: the active account
uses its live settings, another account on this device uses its persisted settings plus pending
edits, and an account never synchronized on this device fails closed (no role written, no
instruction queued) rather than falling back to the active account's profiles. Until a target
catalog resolves, role pickers and action-field options expose only the four built-ins (plus the
explicit clear option where applicable), never custom roles retained from another account. The CLI
resolves from its own authenticated account, which owns every session it can address. Fresh machine
and daemon creation admit a custom assignment snapshot only when its id is still present in that
target account catalog. Existing-session attach, resume, and persisted metadata remain
catalog-independent so a deleted custom profile's self-contained snapshot continues to work.

Delivery has two paths. At creation (`session.spawn_new` `role`, or the optional **Role** control
in the Simple and Wizard New Session composer, kept in device-local draft state across reload and
retry), the resolved snapshot travels as the daemon `sessionRoleV1` spawn option into the session's
initial metadata, and the canonical coding prompt builder adds a `coding.session_role` block from it
before the first provider prompt, independently of execution-run guidance and of the shared base,
so a message that resets `appendSystemPrompt` to null still carries it. The same block is
rebuilt from the retained snapshot whenever a runner starts or resumes, so the role survives
provider restarts without switching to newer defaults. Claude keeps its original default base on
provider resume and after an `appendSystemPrompt` reset or custom append, and re-establishes only
the retained role block through the same builder. A resuming runner receives the validated
`sessionRoleV1` through its short-lived attach handoff (the attach file, written by the daemon and
`happier resume` from the decrypted metadata and deleted on read) and seeds it into the attach base
metadata, so the first provider launch carries the role even when the server metadata snapshot is
unavailable; a server snapshot, when present, stays authoritative. A Claude fast-start resume waits
for that attach outcome before its first local launch; fresh sessions keep launching immediately.
Older attach writers omit the field and older readers ignore it. Startup, resume, and attach always keep the
persisted role or its absence. For a live assign, reassign, or reapply from the row or native
context menu (**Set role…**), or from the `session.role.set` action (`role` is `planner`,
`project_lead`, `worker`, `reviewer`, a current catalog `custom:<uuid>`, or the explicit clear `none`; exposed to session agents, MCP, and the
CLI), the caller records the snapshot through the canonical metadata CAS writer
and then queues a visible chat instruction ("Role assignment: Reviewer", the instructions, and a
note that the assignment changes no permissions, tools, model, or ownership) through the canonical
pending-outbox path with an id derived from the assignment, so it is read on the provider's next
normal turn. Clearing removes only `sessionRoleV1` and queues a visible clearing instruction. UI and
agent paths share one protocol plan (`planSessionRoleChangeV1`) for the snapshot, message text,
and a fresh per-execution assignment and message id. The action schema declares its role choices
through the protocol dynamic-option source; UI and CLI executors resolve that source from the
target account's canonical catalog, omit legacy Delegate and deleted custom profiles, and append
`none` only for the live-set action. An action's `actionRequestId` is correlation,
not identity: agent tool bridges pass MCP JSON-RPC ids, which restart per client connection, so
every `session.role.set` without `resumeActionRequest` is a new visible role change, including a
recycled id or a provider re-running a completed tool call. The id is recorded on the assignment
(`sessionRoleV1.actionRequestId`). Only an explicit resume (`resumeActionRequest`, CLI
`--resume-action-request`) resolves a prior attempt: an assignment while the recorded assignment
still carries that `actionRequestId` and the requested role, replaying its persisted snapshot and
message id. A clear
retains no identity, so a resumed clear is never resolved. Any unresolvable resume returns
`role_change_not_current` and writes and sends nothing, so it never overwrites or clears a later role
change. If the role cannot be recorded nothing is queued; if the instruction cannot be
queued, the UI says the role change was saved but not yet delivered and offers Retry (the same
message), and the action returns `role_instruction_not_delivered` with `roleSaved: true` and the
exact message and id to resend. Pi receives the role block once: its bridge prompt carries it, and
Pi's supplement pass explicitly omits it. No hidden live system-prompt mutation is used.
Reporting between Planner, Project Lead, Worker, and Reviewer is behavioral guidance only. For substantial
delegated work, the built-in Project Lead default instructs the Lead to create its bounded Workers and independent
Reviewer itself through `session.spawn_new`, with an explicit stable role id at creation, before substantive
implementation. The spawn path automatically records immutable `sessionOriginV1.creatorSessionId`. A successful exact
role-aware spawn receipt is the Lead's admission signal; in development source the Lead can also confirm the child's
role and creator through the `session.status.get` and `session.list` readback described under visible agents
below. The Lead records the requested stable role and returned child id,
confirms the child is reachable/active, monitors role-conforming behavior and output, inspects final child output, and
acknowledges it. Creation failure, an unavailable child, or nonconforming behavior is reported visibly rather than
retitling/tagging the Session or continuing with an unassigned child. A child may optionally add
a provenance-labeled `session.message.send` event with `kind: "notice"` when the task packet supplies the Lead id. On
the `session_agent` surface the runtime composes `from` as `<caller session id> <role name>`; a supplied sender naming
another session returns `notice_sender_mismatch`. Such a notice is visibility only: it cannot wait for or wake the Lead, override
model/permission settings, or act as a user instruction. Ordinary spawned Sessions have no automatic completion
delivery to their creator; `notifyParentOnCompletion` belongs only to execution runs and is not a session-spawn relay.

If the original `session.spawn_new` response is unavailable, the public read-only
`session.spawn_recover` action accepts the exact tracked spawn nonce. It resolves exactly one canonical
`session.spawn_new` action operation on the current parent machine, reads its terminal result through the
action-operation owner, and admits the returned child only when the child remains on that machine, its immutable
`sessionOriginV1.creatorSessionId` names the current caller, and it retains a complete role instruction snapshot.
Pending, failed, cancelled, missing, ambiguous, or identity-mismatched attempts return an explicit failure and never
create, rename, retag, reassign, or otherwise mutate a Session.

Existing assignment snapshots and custom profile overrides remain authoritative; changed built-in defaults apply only
to a future assignment or explicit reapply. Installed/runtime acceptance inspects the actual admitted role prompt
(`session.prompt_preview.get`, development source) and the persisted creator id. Mixed-version preservation is source-inspected, not vector-tested, and
is a local-dogfood assumption: the released 0.2.21 UI and 0.2.20 CLI metadata writers spread
unknown fields, and the released UI merges account-settings edits onto the raw server settings.
A current daemon may advertise `daemonSessionRoleV1SpawnSupported: true` as a diagnostic machine-metadata
fact, but metadata is not spawn admission because a downgraded daemon can retain fields written by its
predecessor. Fresh UI and agent-machine creation with an explicit role therefore uses only the exact
`spawn-happy-session.role-v1` daemon RPC. A daemon that does not actively register that method receives
no fallback request, and the caller returns an operation-scoped update/reconnect error instead of silently
creating an unassigned session. An explicit role without a target machine identity is likewise refused
rather than sent to the legacy local control endpoint. Roleless creation retains the provider-safe to
legacy fallback. The role-aware daemon method rejects a missing or null snapshot before tracked-spawn,
custody, or provider execution. Fresh assignment additionally requires nonblank retained instructions,
a nonblank assignment id, and an assignment timestamp before any creation boundary accepts it; persisted,
resume, and legacy readers remain permissive so historical label-only snapshots stay readable. The
underlying ingress still validates the
assignable snapshot and current custom-catalog membership, and the runtime builds the first provider
prompt from the seeded metadata before the first substantive task. Rows show the role as a text badge before the avatar, inside the card, without moving
the card edge or nesting indent. A custom badge uses its retained name and presentation color in
addition to text, never color alone.

### Visible agents and role-bearing runs (development contract)

Status: development source, not released. The protocol contract (`packages/protocol/src/executionRunStartV2.ts` and the
metadata owners named below) and its CLI runner, daemon, and UI consumers are implemented together; the composed
Lead-run acceptance on a live stack has not run yet.

- **Visibility and role on runs.** `review.start`, `subagents.plan.start`, `subagents.delegate.start`, and
  `execution.run.start` accept optional `visibility: 'hidden' | 'session'`, `role`
  (`planner | worker | reviewer | custom:<uuid>`; `project_lead` is refused on runs), and `targetSessionId`. Runs are
  hidden by default. The fields are accepted only on the `session_agent`, `mcp`, and `cli` surfaces; elsewhere they
  return `execution_run_visibility_unsupported` or `execution_run_role_unsupported`, and voice and memory runs never
  carry them. A hidden roleless start, including an explicit `visibility: 'hidden'`, keeps the released
  `execution.run.start` request byte-for-byte, and the fields never reach `intentInput`.
- **Owner defaults.** Account setting `visibleAgentsV1 { v: 1, defaultVisibilityByIntent, defaultRoleByIntent,
  defaultTargetByIntent?, assembleTeamOnLeadAssignment, teamTemplate? }` (lenient per field, passthrough) ships
  every intent hidden, no default roles, and assembly off. `resolveExecutionRunVisibleDefaultsV1` is the one
  resolver: visibility comes only from the start request, so a saved `defaultVisibilityByIntent` never promotes a
  run and a start without visibility keeps the released hidden path; an explicit role wins; a default role fills
  only an explicit visible start; a role is never inferred from the intent. The start echo reports
  `roleSource: 'explicit' | 'settings' | 'none'`.
- **Exact method, no fallback.** A visible or role-bearing start uses only the session RPC `execution.run.start.v2`
  (`ExecutionRunStartV2RequestSchema`). Every older start entry (`execution.run.start`, the embedded `start` of
  `execution.run.ensureOrStart`, and the CLI `session plan|delegate|review start` and `session run start` commands)
  rejects a request carrying any field in `EXECUTION_RUN_START_V2_ONLY_FIELDS`. A host or runner without the method
  yields the typed unsupported error and starts nothing. The response echoes `visibility`, `binding`
  (`created | reused`, null when hidden), `linkedSessionId`, `role { id, name, assignmentId }`, `roleSource`, and
  the effective `permissionMode` and `modelId`; every caller checks it with `verifyExecutionRunStartV2EchoV1`, and a
  missing or mismatched echo is an unassigned run that is reported, not used. The echoed `assignmentId` is the
  child's actual role assignment (the created child's snapshot, or the bound child's recorded `sessionRoleV1`), so
  it matches `session.status.get` readback. An ambiguous start (`execution_run_start_ambiguous`, including a server
  forward cutoff acknowledged as the socket.io ACK timeout after the request was sent) is resumed with the same
  `startRequestId`, which returns the admitted run before bind admission runs; it is never repeated as a new start.
- **Binding.** `targetSessionId` binds an existing child only when its origin creator is the hosting session, its
  role matches the intent (`EXECUTION_RUN_BIND_ROLE_BY_INTENT_V1`: review → reviewer, plan → planner, delegate →
  worker; a custom role only when passed explicitly), it has no active linked run, and its current permission mode,
  model, and session config already equal the run's; an archived child is refused before any link is written.
  Otherwise `execution_run_bind_rejected` with reason `foreign_child | child_archived | role_mismatch | child_busy |
  controls_mismatch`. A run never changes a child's controls; a change
  during a bound run fails it with `controls_changed`. Turn-stream entries on a visible run return
  `execution_run_visible_turn_entry_unsupported`.
- **Run link.** A visible child carries `executionRunLinkV1 { v: 1, parentSessionId, runId, turnEpoch }`, seeded
  before a created child's first turn (child environment `HAPPIER_EXECUTION_RUN_LINK_V1_JSON`) and written through
  the CAS metadata writer before a bound child's task message, whose meta carries the same link under
  `happierExecutionRunLinkV1`; a caller-supplied copy is stripped from user-facing sends. The child wakes the parent
  through the server-relayed session RPC `session.executionRun.childTurn.report.v1`
  (`{ runId, linkedSessionId, turnEpoch, kind: 'linked' | 'turn_completed', turnStatus?: 'completed' | 'failed' }`;
  a failed child turn is reported too); the parent reads the child's transcript forward from the task message. A child that never sends `linked` fails the run with
  `execution_run_visible_child_unresponsive`. Stopping a run because its child was archived passes
  `reason: 'child_archived'`.
- **Visible controller.** The parent runner hosts a visible run as a `session` controller with no provider backend of
  its own. Bind admission runs before any run state exists. A created child receives the run's mapped permission mode
  (`permissionModeForExecutionRunPolicy`), model, and role snapshot, and its first message is exactly the run
  profile's prompt; a bound child receives the task through `sendSessionMessage` with no control overrides.
  `execution.run.send` queues into the child (`prompt` → `enqueue`, `steer_if_supported` → `steer_if_active`,
  `interrupt` → `steer_now`; there is no interrupt action kind). Each report wakes one forward transcript read; the
  first valid output after the task message completes the run exactly once through the same bounded-completion and
  single-repair helper hidden runs use, and earlier invalid outputs the user followed up are skipped. The `linked`
  window is the existing child-provisioning backstop, and the task deadline is the run's bounded timeout (none by
  default), ending in one transcript re-read. Without depending on that deadline, the parent re-reads the child
  transcript once each at 1, 5, and 15 minutes after its latest accepted wake-up (`linked`, a turn report, or
  rehydration), then stops, and a child retries a failed report with bounded backoff (1 s, 4 s, 1, 5, and 15 minutes;
  a newer turn supersedes a waiting retry). A failed child turn without a valid result fails the run with
  `execution_run_visible_child_turn_failed` at the next scheduled re-read, unless the child's usage-limit recovery is
  in progress (`isSessionUsageLimitRecoveryInProgressV1`), in which case the run waits for the resumed turn; a failed
  turn's partial output is not repaired. A repair prompt that cannot be delivered fails the run with
  `execution_run_visible_repair_undelivered`. A mode or model change, seen in child metadata or in a turn's recorded
  message controls, fails the run with `controls_changed`. The completion relay to the parent uses the fixed local id
  `execution-run-completion:<runId>`; its delivery wait is registered before the enqueue, and a relay found by a
  re-read carries the epoch of the child's own latest report record.
- **Recovery.** The daemon run marker carries `visibleRunV1` with identifiers and controls only (D18: link, binding,
  permission mode, notify flag, controls, role `{ id, assignmentId, roleSource }`, whether the child confirmed the
  link, last accepted turn epoch, absolute deadline; never task instructions or role text) and is rewritten on each
  accepted report and on the link confirmation. On startup a parent runner reinstalls its running visible runs from
  those markers, keeps their epoch and deadline, reads the task text and the role back from the child Session,
  re-arms the handshake when the child had not confirmed the link, rewrites each marker under its own process, and
  re-reads the child transcript forward from the task message; a terminal run is not reinstalled. Daemon marker GC keeps a running visible marker whose runner exited until its
  deadline plus the terminal-marker retention. A restarted child re-sends `linked` and resumes its epoch from its
  own `report` record.
- **Turn report and delivery to the Lead (R21).** The link carries three records, each with one writer, all
  written through the existing cross-session CAS metadata writer: `report { turnEpoch, reportedAt, ack: 'pending' |
  'accepted' | 'failed', attempts }` by the child runner from the outcome of its report call; `relay { turnEpoch,
  status: 'queued' | 'failed', localId, at }` by the parent runner from its completion-relay enqueue (queue
  acceptance, not delivery; the enqueue returns no persisted-write receipt); and `delivery { turnEpoch, status:
  'verified', localId, transcriptSeq, verifiedAt }` by the parent runner only after its own turn-input binding of that
  `localId`, or its observation of the committed transcript row for it (the receipt point on delivery paths that emit
  no binding, such as Claude remote), triggers a read of the Lead's persisted transcript that finds the completion
  input carrying the run's structured `runId`; the wait stays registered until such a row is found. `applyExecutionRunLinkDeliveryV1`
  admits delivery only for a queued relay of the same turn and local id, and every patcher ignores another run's
  link. `resolveExecutionRunLinkDeliveryStateV1` is the one display derivation (`sent | queued | relay_failed |
  reported | report_pending | report_failed | not_sent`) for the latest turn; only a verified delivery is `sent`.
  Status readback and the run state (`linkState`) expose the records.
- **Origin.** `sessionOriginV1` keeps `kind: 'agent'` and `creatorSessionId` and gains an optional `via`:
  `{ kind: 'execution_run', runId }` or `{ kind: 'team_assembly', assignmentId }` (`buildSessionOriginV1`,
  `readSessionOriginViaV1`). An origin without `via` is unchanged, older readers still nest by creator, and an
  unknown future `via` reads as null while the origin stays readable.
- **Team assembly.** `planTeamAssemblyV1` returns the idle placeholders (default Reviewer and Worker, or the
  template's entries with their model, provider, and permission mode) for a `project_lead` Lead when the owner
  setting is on. Only the Lead's own runner executes it, and it records `teamAssemblyV1 { v: 1, assignmentId,
  created, skipped, failed, completedAt }` in the Lead's metadata so assembly is idempotent per assignment; a role
  already filled by an assembled or run-hosted child from the same Lead, archived or recorded as created, is skipped.
  The runner attempts assembly on startup and when a new Project Lead assignment appears in its metadata, creates
  placeholders through `createSpawnedSession` with origin `via: team_assembly`, and posts the result as a visible
  notice in the Lead's transcript; a spawn failure is recorded and announced, and nothing hidden is created; a spawn that errors after its session
  already exists is recorded as created, read back from the Lead's children.
- **Readback.** `readSessionLineageReadbackV1` projects `role`, `origin { creatorSessionId, via? }`,
  `executionRunLink { parentSessionId, runId }`, and a Lead's `teamAssembly` for `session.status.get` and
  `session.list` rows. Run state and `execution.run.get` add `visibility`, `binding`, `linkedSessionId`, `role`,
  `roleSource`, and the effective `modelId`; the completion payload adds `role`, `linkedSessionId`, and the
  completing turn's `controls`, and the completion text names the role and linked session.
- **Run-scoped role text.** `buildExecutionRunRolePromptBlockTextV1` renders the catalog instructions with a run
  scope note (the role applies to this run only, the run's output contract takes precedence, session-only steps do
  not apply). Each run profile composes it first, then the caller's instructions, then its output contract.
- **Standalone default.** Account setting `standaloneSessionPromptV1 { v: 1, text }` (shipped empty) is snapshotted
  into a fresh roleless session's metadata as `standaloneSessionPromptSnapshotV1 { v: 1, text, sourceUpdatedAt? }`
  (daemon starts pass it as `HAPPIER_STANDALONE_SESSION_PROMPT_V1_JSON`; terminal starts use the runner's loaded
  settings). The coding prompt builder renders it as `coding.standalone_default` from metadata only while the
  session has no role, so it survives resume and prompt resets; assigning a role removes it from the prompt without
  rewriting the snapshot.
- **Prompt preview.** `session.prompt_preview.get` (session RPC `session.promptPreview.get.v1`, also on the
  `session_agent` surface) returns the live runner's last resolved coding prompt, its block ids and scopes, the launch
  form (`fresh`, or `retained` from the Claude retained launch path), and provider notes. A runner that has not
  resolved a prompt yet returns `prompt_not_resolved`.

Rows participating in session nesting cannot use flat directional or drag ordering.
Explicit folder assignment remains available and does not write flat group order
for those rows. The canonical list move policy is checked again at commit.

These controls affect presentation only. They do not change the session ID,
transcript, immutable origin, sharing, permission modes, runtime access, or the
parent agent's ability to continue communicating. An agent-started label and
avatar shape distinguish the default identity, including a text marker in
provider-logo and no-avatar modes. The row menu shows creator provenance. A parent's
expand/collapse disclosure is the final trailing control of its card. Native
transcript-only subagents are not converted to sessions.

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

Placement and independent-identity presentation are protected from released
0.2.21 color writers by the same session-appearance owner using a separate,
nullable `presentationDbValue` carrier. `GET
/v2/session-organization/appearance-presentations` returns
`{ presentations: [{ sessionId, presentation, updatedAt }] }`; `PUT
/v2/session-organization/appearance-presentations/:sessionId` accepts
`{ presentation }`. The content envelope is opened and sealed with the same
account mode as appearance display. A current client treats a missing route as
unsupported and fails an explicit placement/identity edit visibly; color edits
continue through the released appearance route. Released clients can therefore
replace or clear their legacy color display without deleting the protected
placement/identity bytes, including for E2EE accounts where the server cannot
merge opaque fields. The row remains as a presentation-only tombstone when the
legacy display is cleared and the protected carrier exists. The legacy embedded
placement/identity shape is a readable development predecessor and is copied
into the protected carrier on the next explicit presentation edit; thereafter
the protected carrier is authoritative. There is still one appearance decision
owner, not a second placement registry.

The experimental account feature `sessions.lineageAppearancePresets` is absent
and off by default. When enabled, `sessionLineageAppearancePresetsV1` may carry
passthrough-safe `parent` and `child` presets with optional list density and an
existing avatar-style registry id. A top-level session uses the parent preset
only when it has children; every nested row uses the child preset even when it
also has children and keeps a disclosure. Missing values inherit the ordinary
session-list presentation. Disabling the feature suppresses only this effective
presentation and does not clear the stored presets or any session organization,
role, identity, provenance, or runtime state. Released 0.2.21 account-setting
writes merge onto the raw server baseline before plain or encrypted sealing, so
the unknown toggle and preset keys survive an unrelated old-client edit. FlashList recycling types use
the same effective per-row density result as row rendering, including parent/child presets and their
updates, while retaining body/tail adjacency classes. Narrow native rows keep compact artwork but reserve
48dp row and disclosure interaction geometry on iOS and Android; web retains its compact row geometry.
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
