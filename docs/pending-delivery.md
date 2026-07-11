# Pending delivery architecture

This document is the tracked architecture contract for durable user-input delivery in Dev's evolved Agent/plugin runtime. It distinguishes the released Pending Queue V2 storage/materialization contract from Pending Delivery Attempt V1 (`attempt_v1`). The attempt Interface defined here is admission-off architecture: it does not authorize migration, promotion, claims, runtime refresh, provider launch, or release.

## Frozen vocabulary

- A **pending row** is the exact durable user envelope, stable local id, role, and order owned by the server pending aggregate.
- The sole session contract is derived from `pendingDeliveryProtocolFloor`: floor 1 is `tag_queue_v2`; floor 2 is `attempt_v1`. Rows never select or persist their own contract.
- An **attempt** is one authorized effort to dispatch the FIFO head. Its public attempt id is correlation, never authority.
- `reserved` is positively pre-write. `write_authorized` means the host CAS succeeded and bytes may have been written after its acknowledgement.
- Reserved expiry has one no-write outcome literal: `expired_pre_write` with `no_provider_write`.
- **Terminal custody** means an Agent/provider surface visibly owns the prompt. It is not provider acceptance and cannot satisfy `runtime_handoff`.
- **Exact acceptance** is attempt-bound evidence under an adopted provider-session, attachment, cursor, and receipt scope.
- **Ambiguous after write** means a write may have occurred. Automatic resend is forbidden.
- `runtime_handoff` is legal only when a non-TUI provider-submission boundary returns a positive synchronous acknowledgement stronger than injection or custody.
- `attempt_evidence` requires exact, replay-safe Agent/provider evidence. Missing evidence ownership, uniqueness, or replay-horizon facts make the runtime `unsupported`.
- Runtime-input handoff and provider-delivery mode are separate declarations. Durable floor-1 input ownership does not imply provider delivery or promotion eligibility.
- Claim credentials, runtime authority, human requests, and server transitions are distinct authority domains.

## Canonical owners

| Concern | Owner |
|---|---|
| Public attempt vocabulary and runtime declaration validation | `packages/protocol/src/sessions/messages/pendingDeliveryAttemptV1.ts` |
| Tag-era coarse pending projection | `packages/protocol/src/sessions/messages/pendingDeliveryStatusV1.ts` |
| Durable rows, attempts, barriers, outcomes, receipts, FIFO, and transitions | the server pending aggregate introduced by D1 |
| Runtime election and runtime authority | the current-runtime owner introduced by R0 |
| Runtime-input integration | `apps/cli/src/agent/runtime/session/input/**` and the host-session/public-runtime bridge |
| Exact Agent/provider evidence | Agent-owned adapters behind the provider-neutral attempt Interface; Claude terminal mechanics remain under `packages/plugins/claude/src/agent/runtime/terminal/unified/**` |
| Pending-to-transcript projection and ready/attention effects | the O1b server transaction owner |
| UI presentation and user actions | generic pending/session projection consumers; plugins contribute Agent facts rather than owning delivery state |

Protocol schemas validate boundary shapes. They do not implement a durable transition kernel. Server routes, runtime hosts, Agent plugins, UI code, migrations, and test harnesses must call the future canonical owners rather than reproduce their decisions. No feature, server, plugin, or runtime consumer is enabled merely because this public Interface exists.

## Receipt identity boundary

The public protocol exposes only the `provider_session_epoch | global_unique` receipt-scope schema and inferred type as a runtime capability fact. Receipt namespace, scope id, aliases, registry and authority revisions, digest, key version, raw receipt, and acceptance internals remain private server facts; API, socket, UI, log, metric, plugin, and shared-QA projection of those facts is forbidden.

`provider_session_epoch` is selected from a private server-owned epoch bound to one Happier session and the adopted provider-session, attachment, and cursor origin. Its private receipt identity commits the Happier session. `global_unique` instead proves uniqueness across Happier sessions inside one server-owned collision domain: Happier `sessionId` is attribution only and cannot partition the collision identity.

One allowlisted private registry owns the collision namespace and compatibility-stable canonical global scope. Compatible scope-id renames are lookup-only aliases, and delayed predecessor evidence cannot be relabeled as current. One private aggregate-owned receipt-write authority serializes acceptance with key and registry rotation; the keyring remains the sole crypto and key-version owner, while D1a remains the future HMAC, database, and acceptance implementation owner.

Retained keys, authority epochs, canonical and alias scopes, receipts, outcomes, and replay tombstones cannot be retired while referenced or while provider evidence remains replayable. An unknown replay horizon makes `attempt_evidence` unsupported.

## Admission-off boundary

The attempt Interface is additive and fail closed. Future contract admission and claim admission are separate server-represented controls:

1. Contract admission will govern creation of floor-2 sessions and owner-approved promotion.
2. Claim admission will govern creation of new delivery attempts for an already floor-2 session.
3. Disabling either control must never disable exact completion, cancellation, or owner-authorized manual recovery of already admitted work.

Those controls, policies, routes, feature declarations, runtime capability projections, schema migrations, and consumers are intentionally outside this D0 Interface. Until their independently reviewed corridors land, Dev creates no attempt-aware session or claim from this module.

## Transition contract

| From | To/result | Required evidence | Forbidden inference |
|---|---|---|---|
| no attempt | `reserved` | FIFO head, claim admission, capable current runtime, runtime authority | account/session ownership alone |
| `reserved` | `write_authorized` | Agent/provider `ready_to_write` followed by host phase CAS | composer emptiness, presence, time |
| `reserved` | `expired_pre_write` or another pre-write terminal result | locked server-time expiry or other positive `no_provider_write` proof | timeout after authorization |
| `write_authorized` | `terminal_custody` | bounded custody observation | acceptance or later-row credit |
| authorized/custody | exact accepted/rejected result | matching attempt evidence or eligible provider-submission acknowledgement | text equality, banner, output, heartbeat |
| authorized/custody | `ambiguous_after_write` | lost/uncertain post-write result | automatic retry |
| any active phase | `cancel_requested` or terminal cancellation | phase-aware canonical transition | physical row deletion |

Lease expiry never manufactures provider acceptance or rejection. Reserved expiry closes as `expired_pre_write` with `no_provider_write`, and a later attempt receives a new id and credential. Expiry after authorization is an ordering barrier. A duplicate-risk resend is a separate owner-authorized operation with a new stable local id.

## Human authorization

- Authorized viewers may list derived pending state.
- Editors and owners may enqueue and perform ordinary pre-write edit, reorder, discard, restore, dispatch, steer, and separately receipted interrupt requests.
- `cancel` is a distinct editor-or-owner action. D1a/D1b enforce phase behavior: pre-write cancellation may close no-write; post-write cancellation only requests provider cancellation and preserves possible-write ambiguity until exact closure.
- Only the session owner may promote an existing session, resolve possible-write/input ambiguity, or authorize duplicate-risk resend.
- Human authority never substitutes for runtime credentials or provider evidence. Runtime credentials never grant edit/share authority.

Future routes and services must use the existing canonical session-access helpers so forbidden/not-found privacy behavior is preserved.

## Mode B compatibility boundary

Bounded coexistence is mandatory while deployment, database, or runner facts remain unknown. Floor-1 and floor-2 adapters stay physically separate but converge on one pending-aggregate action router.

Promotion snapshots an immutable cutoff and closes new legacy admissions. Runtime-input retirement accounts for every HTTP, socket, and in-process range/ordinal plus the elected input owner's authenticated cutoff acknowledgement. Provider-delivery retirement separately requires an exact attempt receipt, an exact eligible `runtime_handoff` outcome, or session-owner resolution for every lineage. Transcript presence, input handoff, custody, assistant output, queue emptiness, liveness, and time cannot close provider delivery.

If either retirement proof is missing, the session remains floor 1 with a typed blocker and the compatibility adapter remains live. A feature marker or row marker cannot fence a genuinely old server binary. After floor-2 state exists, rollback is forward-fix to an attempt-aware build with new admission off unless a complete tested back-migration runs under quiescence.

## User-visible guarantees

- The exact original envelope is durable before dispatch or Agent/provider launch.
- A queued row remains visible and ordered until a canonical transition resolves it.
- Custody/possible-write states are attention-worthy and never silently resent.
- Accepted input projects pending-to-transcript once; provider acceptance, output durability, participant readiness, and notification remain distinct facts.
- Unknown runtime declarations and future states fail closed as upgrade-required/unsupported rather than falling back to direct text delivery.
- Delivery failure never authorizes host destruction, automatic runner refresh, or automatic provider resume.

## Privacy bounds

Public API/socket/UI presentation may include session/local/public-attempt correlation, bounded phase/reason/action, and CAS versions. It must not contain raw or digested runtime/claim/recovery credentials, receipt namespace/scope/digest, provider session ids, raw receipt/hook/screen evidence, or prompt fingerprints.

Raw credentials and provider receipts are transient within their authenticated runtime/server request boundary. Future server storage retains only the contract-approved keyed verifier/outcome/receipt material. Logs, metrics, telemetry, snapshots, and QA evidence follow the sink-specific allowlist in `docs/encryption.md` and the living reliability plan; content and secrets are never copied for diagnostics.

## Supersession and deletion ledger

The following are bounded compatibility surfaces, not alternate attempt owners:

- `PendingDeliveryStatusV1` describes July/tag-era behavior only and must not gain optional attempt fields or receipt authority.
- Tag-era materialization and watermark/catch-up remain only behind the floor-1 adapter.
- Local-id-only accept/block/retry/handled routes, custody-as-acceptance callbacks, Agent-local conversation FIFO, and caller-selected materialize/claim branches must be fenced and removed by their owning implementation corridors.
- Runtime-input cursors must never be relabeled as provider-acceptance cursors.
- Plugin declarations consume the public runtime capability shape; they do not redeclare receipt scopes or own persistence/acceptance.
- Testkits may parse raw responses and compose real HTTP/session-RPC owners, but may not define attempt phases, outcomes, a queue, an aggregate, or transition decisions.

Compatibility code is deleted only after supported floor-1 sessions/runtimes are absent, every input admission is accounted for, every provider-delivery lineage is closed, and the zero-bypass searches pass. Until then it remains narrow, boundary-owned, and unreachable for floor-2 input.
