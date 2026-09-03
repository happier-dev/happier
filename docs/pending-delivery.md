# Pending delivery architecture

## Current Queue V2 activation ownership

Pending Queue V2 remains the sole durable owner of message custody, ordering, and exact-row actions. An inactive-session start request is a small session-level authorization for the current eligible `send_now` row; it is not another message-delivery state machine.

- The server transaction that mutates Pending rows is the only writer of the current activation authorization. It arms one exact request, clears only that request when its row no longer asks to send now, and never silently retargets older queued input.
- `Session.lastActiveAt` is the lifecycle fence. An authorization at or before that value is stale and is not projected. Publisher activity therefore invalidates an old start request without a second client-owned timestamp.
- The Pending activation hint is lossy notification only. The authorization persisted on `Session` is authoritative.
- The daemon on the session's exact owning machine is the only unattended starter. It consumes live hints and one finite reconnect scan through the same activator, re-reads the session and exact Pending row, and then uses the existing inactive-session resume path.
- Machine unreachability leaves the request in `waiting`. A genuine terminal inability to start records `failed`; it is not retried merely because a daemon reconnects. Explicit retry reuses the existing Pending `send_now` action.
- Current clients delegate unattended starts only when the server advertises Pending Input V2 and the exact target machine advertises daemon activation support. Otherwise they retain the released direct-resume compatibility path.
- The account preference has one three-state owner. `when_available` persists `send_now` and therefore authorizes the daemon; `online_only` persists `enqueue` and makes at most one user-present UI resume attempt when the exact machine is currently reachable; `manual` only persists `enqueue`. The default is `online_only`.
- The `online_only` attempt never delegates to the daemon and never changes the row to `send_now`. If reachability changes or the attempt fails, Pending custody remains without authorization for a later unattended start.
- The banner action **Process when online** reuses the exact-row Pending `send_now` mutation for the displayed message. It does not change the account preference or create a second activation path.

This design intentionally has no polling loop, lease, generation, retry counter, or client-side activation clock. Pending owns the payload; the server owns activation intent; session activity fences staleness; and the daemon owns process start.

> **Superseded attempt-design record (2026-07-14).** Queue V2 is the only active pending-delivery system. `attempt_v1` will not be activated: its runtime/protocol branches are removed after the live exact-selector contract is extracted, and its schema/migrations are squashed or forward-contracted from bounded persistence evidence. Current authority and markers: `.project/plans/pending-delivery-attempt-v1-and-session-lifecycle-reliability-unification.md`. Everything below this notice is historical design evidence, not implementation or cutover instruction.

## Historical attempt design

Pending Queue V2 remains the released durable payload and ordering owner. The following describes the abandoned admission-off attempt proposal.

## Canonical ownership

- `SessionPendingMessage` owns the exact encrypted/plain envelope, stable `localId`, role, position, and retained row disposition.
- Enqueue selects `tag_queue_v2` or `attempt_v1` once. A retry reuses the persisted selection and cannot change it.
- `packages/protocol/src/sessionMessages/pendingDeliveryAttemptV1.ts` owns only bounded attempt identity, claim selectors, the pure transition table, exact-coordinate release, and derived presentation.
- `pendingDeliveryAttemptAdmission.ts` owns the single fail-closed server admission decision. Feature advertisement, enqueue selection, and the dormant claim registrar all consume that same decision; it remains hard-disabled until the cutover gates pass.
- `pendingDeliveryAttemptEnqueueSelection.ts` translates that admission decision into the immutable protocol selected by the enqueue transaction. It is not a second gate.
- `pendingDeliveryAttemptAuthorization.ts` maps bounded human actions to the existing session access levels. Runtime claim authority remains a separate R0 concern.
- D1 will own the sole durable aggregate transaction service. Routes, sockets, workers, runtimes, providers, and UI must not write attempt or row lifecycle state directly.
- Runtime Activity remains externally owned. Pending will later consume only its typed decision and exact revision; it does not infer, time out, or write Activity truth.

## Admission boundary

There is one server-owned admission decision. It drives the advertised `sharing.pendingDeliveryAttempts` bit, immutable protocol selection at enqueue, and registration of the dormant claim transport. The decision is currently hard false; missing, malformed, or non-true advertised values therefore select the released queue contract.

The decision only makes the attempt corridor reachable; it does not authorize an individual claim. Claim authorization belongs to the D1/R0 aggregate transaction and must prove the persisted attempt contract, session active-attempt coordinate, current authenticated runtime authority, exact attempt identity, expected revision, and scoped unlogged idempotency key.

Disabling the gate must never prevent exact completion, cancellation, ambiguity resolution, or recovery of already persisted attempt work.

## Attempt kernel

One public attempt id identifies an attempt but grants no authority. The pure kernel recognizes:

`reserved → write_authorized → custody_observed → accepted`

Only exact attempt identity and expected revision can advance a state. Custody is nonterminal and never acceptance. Weaker synchronous provider submission terminates as `handoff_acknowledged`, which remains observably distinct from `accepted`.

Pre-write terminal outcomes are `retryable`, `blocked`, `cancelled`, and `dead_letter`. Post-authorization uncertainty terminates as `ambiguous`; it is never automatically retried. Owner resolution is explicit.

The session active-attempt coordinate is released only when it still equals the exact terminal attempt id. A stale terminal completion cannot clear a successor.

Head and owner-authorized exact-target dispatch share one selector contract. Exact-target dispatch identifies the stable `localId` and the deliberate `send_now | steer` override; it cannot request reorder or substitute another row.

## Derived presentation

Coarse presentation is a pure derivation from retained row disposition plus the current/latest attempt facts. No writable queued/delivering/custody/accepted twin is permitted.

- no attempt projects queued;
- reserved/write-authorized project delivering;
- custody-observed projects custody;
- terminal outcomes retain their exact names, including `handoff_acknowledged` and `ambiguous`.

The public shape may contain bounded row/attempt correlation, phase, outcome, reason, and revision. It must never contain the scoped idempotency key, provider secrets, raw evidence, content, or private runtime authority.

## Human actions

Viewers may inspect derived state. Editors may enqueue, edit/reorder/discard/restore safe pending rows, cancel before write, and request ordinary dispatch/steer/interrupt actions. Provider cancellation, hide/mark-handled, ambiguity resolution, and duplicate-risk resend are owner-only and remain distinct operations.

Human ownership never substitutes for authenticated current-runtime authority, the scoped claim idempotency key, expected-revision CAS, or exact provider evidence. UI removal is not provider cancellation and cannot delete replay fences.

## Physical compatibility fence

D1 persists attempt-retained rows with `status='attempt_queued'`. The released June materializer selects only `status='queued'`, so it cannot select those rows. Public projection maps `attempt_queued` to queued without creating a writable lifecycle shadow.

The fence, aggregate kernel, and admission-off schema exist in Remote and Dev. They remain unreachable from production enqueue because the single admission decision is hard false; cutover remains blocked until a real provider claim/evidence/mutation consumer is proven.

## Deferred work

Exact provider evidence history is deferred. A future evidence phase may add bounded, crash-safe attempt-bound receipts after provider capabilities and retention requirements are proven. D0 defines no receipt-scope registry, receipt key history, evidence capability catalog, provider declaration, or provider-specific branch.

Provider cancellation transport, consumed provider evidence adapters, owner resolution UI, cutover migration, and live ship proof remain downstream corridors. A separate runner incarnation or cryptographic claim-verifier layer must not be added unless a discriminating executable failure proves the existing authenticated channel, revision CAS, and scoped idempotency key insufficient.

## Deletion gate

Before production cutover, searches must show no active alternate owner for:

- numeric protocol floors or floor-to-contract mapping;
- per-session protocol promotion or cohort admission;
- a separate claim feature gate;
- receipt-scope/evidence-history capability scaffolding;
- provider/catalog pending-attempt capability constructors;
- direct durable transition writers outside the future aggregate;
- mutable coarse attempt presentation state;
- automatic retry after possible provider write;
- provider or Runtime Activity branching in the shared kernel.
