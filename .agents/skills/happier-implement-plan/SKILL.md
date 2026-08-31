---
name: happier-implement-plan
description: Use only when the current user explicitly asks to implement, execute, resume, continue, or complete an approved Happier repository implementation plan. Preserve the plan as the authoritative execution contract while applying the common happier-implement workflow to every implementation unit.
---

# Happier Implement Plan

Execute an approved plan as its orchestrator and integrator. Read and apply `.agents/skills/happier-implement` for the common implementation workflow; this skill adds plan authority, execution-state, amendment, boundary-review, and completeness rules. It does not create, materially refine, approve on the user's behalf, or redesign a plan.

## 1. Resolve authorization and the execution contract

- Identify the exact plan path, approved contract revision, intent, exclusions, material requirement/invariant IDs, execution units, acceptance criteria, and designated tracking area.
- The current user's explicit direction to implement a named plan is execution authorization and may serve as approval when that same plan was awaiting approval. Record approval only in the plan's designated identity area; do not alter requirements while doing so.
- If several plans could match, the named plan is unavailable, or approval would select among materially different contracts, resolve that ambiguity before production edits.
- Do not create a replacement plan, add unapproved requirements, or turn ordinary implementation decisions into amendments.

Route plan authoring and user-approved amendments to `.agents/skills/happier-plan`; route deep review, QA, finding triage, and authorized review-fix loops to `.agents/skills/happier-review`.

## 2. Recover current state without reopening design

Read the complete approved plan when it is not already active in context. Recover:

- approved intent, target state, decisions, exclusions, negative requirements, and acceptance criteria;
- current execution statuses and evidence pointers;
- completed, active, blocked, and ready execution units;
- current code/test anchors and external contracts the next unit relies on;
- active delegated runs and durable reports that actually exist;
- relevant current diff, dirty-worktree state, plan relationships, and shared conceptual seams.

Uncommitted work is normal. Inspect and preserve it; it does not reserve a file or justify skipping the requested change.

Do not add a generic preflight plan-review phase. Recheck only load-bearing anchors that may have moved, then begin. If primary evidence materially invalidates the approved contract, follow the amendment procedure instead of silently changing course.

## 3. Build the plan critical path and ready queue

Use `.agents/skills/decompose-gates` when the plan needs lane decomposition. Map:

- independently verifiable consumed verticals and their material requirement/invariant IDs;
- dependencies and the earliest check that can invalidate downstream work;
- ready implementation, QA-preparation, deterministic migration, validation, and scheduled review work;
- shared conceptual seams and the lane responsible for integrating each decision;
- actual collision surfaces: same edit hunk, incompatible live-contract decisions, destructive moves/rewrites, single-producer generated output, or exclusive mutable runtime resources;
- the fewest substantial integrated boundaries that receive formal independent review.

Name a precondition only when plan ordering cannot guarantee it: external authority/credentials, runtime/device availability, released artifacts, immutable external contracts, or other environment state. Verify it read-only before dependent work when practical. Do not create precondition ceremony for ordinary code dependencies.

Use maximum useful parallelism. Keep ready independent work moving when it shortens the critical path and dispatch newly unblocked work without waiting for unrelated lanes. Do not target a fleet size or create filler lanes. File overlap alone is not a collision.

## 4. Dispatch meaningful plan-aware lanes

Delegate complete responsibilities, not tiny searches or isolated edits. Every meaningful implementation, review, or QA lane reads the complete approved plan once unless it is already active in that lane's context. Reference the on-disk plan rather than pasting it.

For Codex, set `fork_turns` explicitly and default to `fork_turns="none"`; inherit only the minimal recent context that is indispensable. Each brief includes:

- plan path/revision and requirement/gate IDs;
- real intent, exact corridor, current evidence, and paths/symbols;
- dependencies, preconditions, and seam/resource coordination;
- dirty-state warning and instruction to preserve compatible work;
- concrete completion and negative criteria;
- required RED/GREEN, broader validation, and live QA;
- authorized scope, expected write corridor without exclusive reservations, output/evidence, and stop/fallback conditions.

A lane owns its analysis, implementation, focused tests, relevant validation, compact self-review, and concise result. Tell it that it is not alone in the checkout. Do not paste bulky logs, diffs, or generic doctrine into briefs.

## 5. Execute every unit through `happier-implement`

Apply the complete workflow in `.agents/skills/happier-implement` to each execution unit:

- derive required observable truths and outermost deciding evidence from the approved plan;
- discover the current canonical owner and affected corridor;
- use scope-preserving solution economy inside the complete approved outcome;
- implement through a consumed path with meaningful TDD;
- migrate/remove approved duplicate, bypass, legacy, and split-brain paths;
- validate affected neighboring behavior and required live surfaces;
- resolve uncertainty through evidence rather than skipping work;
- use efficient generators, codemods, and deterministic tools when they reduce omissions and turns;
- perform compact author self-review before handoff.

The plan remains authoritative. Use best judgment only for details it intentionally leaves open. Do not reduce required integration, migration, removals, compatibility, UX, platform support, testing, or validation.

Lane outcomes are `VERIFIED_COMPLETE`, `IMPLEMENTED_NOT_VERIFIED`, `PARTIAL`, `BLOCKED`, or `AMENDMENT_REQUIRED`. A worker's `DONE` report is a claim, not final status.

## 6. Keep plan state useful

Keep the approved contract stable. The orchestrator alone updates overall execution status, cross-lane dependencies, finding dispositions, amendment record, and final verdict. Lane agents update only the status/evidence area assigned by the plan.

Record a durable transition only when it changes gate readiness, dependency availability, blocker state, approved authority/contract, substantial review-boundary state, or final verdict. Ordinary dispatches, RED/GREEN iterations, fixes, validations, and self-checks remain in command output and concise handoffs. Do not turn the plan into a transcript or create parallel ledgers.

After compaction or resume, reread the plan pivot and mutable execution state only when they are no longer active or may have changed. Reuse completed evidence and run identities rather than restarting work. Never persist credentials or private access material in plans or reports.

## 7. Monitor, integrate, and review at usable boundaries

Let healthy long-running agents and commands reach terminal state. Prefer completion notifications, background sessions, or bounded terminal waits over busy polling. A timeout is not a failure; inspect current state.

As lanes finish, inspect their diffs and deciding evidence sufficiently for integration, update material state, and dispatch newly ready work. Reuse the same lane for context-local corrections when practical. Steer or reassign only for evidence of stall, wrong scope, missing context, repeated failure without new information, or an actual collision.

QA design, environment checks, fixtures, and advisory inspection may run alongside implementation. Record PASS/FAIL only after the relevant consumed vertical is runnable. Formal independent review is normally batched at the plan's substantial integrated boundaries, explicit user-requested points, high-risk triggers that cannot safely wait, user-visible ship gates, and final plan completeness—not every unit or microchange.

## 8. Triage findings without surrendering plan authority

Review findings are candidate claims. Reproduce or re-derive each claim, then separately adjudicate defect, impact, proposed response, and authority through `.agents/skills/happier-review`. A confirmed defect may still have an overengineered proposed fix.

Cluster authorized fixes by originating failure layer, root cause, and canonical owner. A routine lane may diagnose, fix, and retest its accepted issue through `.agents/skills/happier-implement`. Re-review the accepted-finding delta and affected corridor; repeat a full round only when the approved contract, architecture, scope, boundary, or risk materially changed.

## 9. Amend only with user approval

When primary evidence shows an approved requirement is unsafe, contradictory, impossible, materially stale, or unable to serve the approved intent:

1. pause the affected unit;
2. record exact evidence and impacted requirement/gate IDs;
3. propose the smallest coherent amendment and its effects;
4. mark `AMENDMENT_REQUIRED` and obtain user approval;
5. route the approved amendment through `.agents/skills/happier-plan`;
6. resume from the updated contract revision.

Evidence and review findings can challenge the plan but cannot supersede it. Continue unaffected independent work only when it cannot prejudge the decision.

## 10. Close only from evidence

Before declaring plan completion:

- map every material requirement/invariant to `VERIFIED_COMPLETE`, approved supersession, or defensible `NOT_APPLICABLE`;
- verify canonical ownership, reachable wiring, required removals, RED/GREEN proof, broader validation, and material live QA;
- preserve `IMPLEMENTED_NOT_VERIFIED` wherever behavior is present but not exercised;
- use `.agents/skills/verify-claims` for decision-material delegated claims at the applicable boundary;
- run final plan-completeness review through `.agents/skills/happier-review`;
- run `.agents/skills/attack-conclusion` against omissions, neighboring cases, split-brains, environment gaps, and unsupported confidence;
- report through `.agents/skills/handoff-report`, including failed/skipped validation, blockers, and residual risk.

Stop only when the authorized plan is verified complete, a decision-material unit is genuinely blocked with its missing prerequisite named, or a user decision on `AMENDMENT_REQUIRED` is necessary. Files, compilation, checkboxes, stopped agents, and partial test success are not completion.
