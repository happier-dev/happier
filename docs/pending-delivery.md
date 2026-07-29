# Pending delivery architecture

> **Superseded attempt-design record (2026-07-14).** Queue V2 is the only active pending-delivery system. `attempt_v1` will not be activated: its runtime/protocol branches are removed after the live exact-selector contract is extracted, and its schema/migrations are squashed or forward-contracted from bounded persistence evidence. Current authority and markers: `../remote-dev/.project/plans/pending-delivery-attempt-v1-and-session-lifecycle-reliability-unification.md`. Everything below this notice is historical design evidence, not implementation or cutover instruction.

## Historical attempt design

Pending Queue V2 remains Dev's released durable payload, ordering, delivery-state, and compatibility owner. The following describes the abandoned admission-off attempt proposal.

## D0 owners

- Enqueue chooses `tag_queue_v2` or `attempt_v1` once. A retry must preserve the persisted selection and cannot change protocol.
- `packages/protocol/src/sessions/messages/pendingDeliveryAttemptV1.ts` owns bounded public attempt identity, strict claim selectors, the pure transition table, exact active-coordinate helpers, automatic-retry classification, and derived presentation.
- `apps/server/sources/app/session/pending/pendingDeliveryAttemptEnqueueSelection.ts` owns the pure fail-closed selection decision. It is intentionally unwired and hard-disabled in D0.
- `apps/server/sources/app/session/pending/pendingDeliveryAttemptAuthorization.ts` maps bounded human actions onto Dev's existing session access levels.
- Dev Agent/plugin runtime architecture remains under `apps/cli/src/agent/**` and `packages/plugins/**`. D0 adds no runtime or provider adapter.

No writable coarse attempt state exists. Presentation is derived from retained attempt facts and row disposition.

## Feature boundary

`sharing.pendingQueueV2` and `sharing.pendingDeliveryState` remain the released queue and July delivery-state compatibility gates. They are not attempt admission.

There is one attempt gate: `sharing.pendingDeliveryAttempts`. It is server-represented, fail closed, depends on Pending Queue V2, and is advertised disabled in Dev. There is no second claim gate, per-session floor, promotion/cohort gate, or provider capability gate.

## Pure attempt lifecycle

The canonical path is:

`reserved -> write_authorized -> custody_observed -> accepted`

- Custody is nonterminal and is never acceptance.
- `handoff_acknowledged` is terminal but observably weaker than `accepted`.
- Possible-write failure becomes `ambiguous`; it cannot automatically retry.
- Only explicit pre-write `retryable` may automatically retry.
- Pre-write cancellation, provider cancellation request/result, owner ambiguity resolution, and hide/mark-handled remain distinct.
- Handled presentation retains the terminal outcome and replay fence.
- Every transition checks exact attempt identity, expected revision, and predecessor phase.
- Repeating a terminal command is rejected by revision or phase without mutation.

The public command union includes every accepted kernel command, including the payload-bearing `record_provider_cancellation_result` command.

## Selection and coordinate invariants

Claims use exactly one selector:

- `{kind:'head'}`; or
- `{kind:'exact_target',localId,ownerAuthorizedOverride:'send_now'|'steer'}`.

Exact-target selection carries no reorder or substitution field. D1 must prove the transaction either claims that exact row or fails.

Only one attempt id may occupy the session coordinate. Reacquiring the same id is idempotent; a competing id is rejected. Terminal release clears the coordinate only when it still names that exact attempt, so a stale completion cannot clear a successor.

## Human authorization

- Viewers may inspect derived state.
- Editors may enqueue, edit, reorder, discard, restore, cancel before write, dispatch, steer, and interrupt.
- Only the actual session owner may request provider cancellation, hide/mark handled, resolve ambiguity, or authorize duplicate-risk resend.
- Unknown action values and shapes fail closed.

These human permissions never substitute for the future runtime incarnation, claimant credential, revision CAS, or provider evidence.

## D1 and later boundaries

D1 will add the attempt child, `Session.activePendingAttemptId`, portable transaction/CAS behavior, and the physical `status='attempt_queued'` fence across PostgreSQL, SQLite, and MySQL. Public projection will continue to report retained attempt rows as queued. Admission remains off.

R0 later consumes the separate Runtime Activity authority's typed revision-bound decision and the reviewed runner-incarnation binding. Pending must not create its own Activity timer, infer Activity from foreground turns, or mint rival supervisor/generation authority.

D2 integrates exact attempt context through Dev's Agent/plugin runtime owners. D3 converts callers and UI. Released delivery-state writers and compatibility paths remain until their reviewed cutover corridor replaces them.

## Explicitly absent from V1

V1 has no receipt history, provider evidence journal, provider capability ceremony, numeric protocol floor, promotion cohort, second claim gate, caller-local admission switch, mutable row-level attempt lifecycle, provider branch in shared core, or automatic resend after possible write.

Secrets, raw provider evidence, content, and credentials never belong in public state, logs, metrics, transcript metadata, or UI.
