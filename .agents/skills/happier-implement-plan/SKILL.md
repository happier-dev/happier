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
- required RED/GREEN plus the risk-applicable broader and live validation tiers; when composed QA is owned by a later integrated boundary, name that boundary and keep the lane `IMPLEMENTED_NOT_VERIFIED` until its required evidence lands;
- authorized scope, expected write corridor without exclusive reservations, output/evidence, and stop/fallback conditions; pair each prohibition with its safe procedure and state the blast radius, following `.claude/CLAUDE.md` "Delegation shape".

A lane owns its analysis, implementation, focused tests, relevant validation, compact self-review, and concise result. Tell it that it is not alone in the checkout. Do not paste bulky logs, diffs, or generic doctrine into briefs.

## 5. Execute every unit through `happier-implement`

Apply `.agents/skills/happier-implement` to each execution unit, using the approved requirements as its outcome and evidence contract. Validate at the earliest tier that consumes the changed behavior, batching shared package/runtime setup under root **Validation** without dropping a material obligation.

The plan remains authoritative. Use best judgment only for details it intentionally leaves open. `AMENDMENT_REQUIRED` applies only when an approved outcome would change; ordinary choices within the approved intent stay with the implementer. Do not reduce required integration, migration, removals, compatibility, UX, platform support, testing, or validation.

Lane outcomes are `VERIFIED_COMPLETE`, `IMPLEMENTED_NOT_VERIFIED`, `PARTIAL`, `BLOCKED`, or `AMENDMENT_REQUIRED`. A worker's `DONE` report is a claim, not final status.

## 6. Keep plan state useful

Keep the approved contract stable. The orchestrator alone updates overall execution status, cross-lane dependencies, finding dispositions, amendment record, and final verdict. Lane agents update only the status/evidence area assigned by the plan.

Record a durable transition only when it changes gate readiness, dependency availability, blocker state, approved authority/contract, substantial review-boundary state, or final verdict. Ordinary dispatches, RED/GREEN iterations, fixes, validations, and self-checks remain in command output and concise handoffs. Do not turn the plan into a transcript or create parallel ledgers.

After compaction or resume, reread the plan pivot and mutable execution state only when they are no longer active or may have changed. Reuse completed evidence and run identities rather than restarting work. Never persist credentials or private access material in plans or reports.

## 7. Monitor, integrate, and review at usable boundaries

Follow root **Efficient execution and uncertainty resolution** for notification/wait selection, task-local reuse of operation handles, and resume-before-replace recovery. A pending wait may be continued without new evidence; restarting work or repeating equivalent failed attempts requires a changed prerequisite or a materially different evidence path.

As lanes finish, inspect their diffs and deciding evidence sufficiently for integration, update material state, and dispatch newly ready work. Reuse the same lane for context-local corrections when practical. Steer or reassign only for evidence of stall, wrong scope, missing context, repeated failure without new information, or an actual collision.

QA design, environment checks, fixtures, and advisory inspection may run alongside implementation. Record PASS/FAIL only after the relevant consumed vertical is runnable. Formal independent review is normally batched at the plan's substantial integrated boundaries, explicit user-requested points, high-risk triggers that cannot safely wait, user-visible ship gates, and final plan completeness—not every unit or microchange. A QA-driven fix wave is a substantial boundary once it has landed about 10–15 fixes or run two days of active waves without an independent finding-delta review.

When the same user-visible symptom returns after a fix by a different owner, stop routing it owner by owner. Start one joint diagnosis lane that traces the whole path, from its entry point through every owner to the output, before the next fix.

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
- for each UI/feature lane, include a checklist of every plan row and lab element for its surface, marked built, ruled out (with authority), or owed; owed items keep the lane short of `DONE`;
- verify canonical ownership, reachable wiring, required removals, RED/GREEN proof, broader validation, and material live QA;
- preserve `IMPLEMENTED_NOT_VERIFIED` only where an executor-runnable check exists and has not been run; evidence that only release automation or human QA can produce (devices, tenants, mail, signing, packaging, production-like infrastructure) is recorded once as a named release check, not as `IMPLEMENTED_NOT_VERIFIED`, and a plan whose only open items are release checks is implementation-complete;
- do not add gates, ledgers, evidence matrices, certification sections, or review rounds in order to reach completion; if the remaining work is release checks, declare implementation-complete and list them;
- use `.agents/skills/verify-claims` for decision-material delegated claims at the applicable boundary;
- run final plan-completeness review through `.agents/skills/happier-review`;
- run `.agents/skills/attack-conclusion` against omissions, neighboring cases, split-brains, environment gaps, and unsupported confidence;
- report through `.agents/skills/handoff-report`, including failed/skipped validation, blockers, and residual risk.

Stop only when the authorized plan is verified complete, a decision-material unit is genuinely blocked with its missing prerequisite named, or a user decision on `AMENDMENT_REQUIRED` is necessary. Files, compilation, checkboxes, stopped agents, and partial test success are not completion.
