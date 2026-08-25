---
name: happier-review
description: Conduct evidence-backed Happier code, plan-completeness, session, worktree, feature, commit, branch, PR, codebase, and release-readiness reviews with affected-corridor analysis, high-confidence finding triage, meaningful parallel lanes, proportionate but comprehensive QA, optional root-cause fixes, and independent closeout. Use for deep review, audit, QA, pre-merge assessment, plan-vs-implementation verification, review-and-fix loops, or when asked to inspect all related code rather than only changed lines.
---

# Happier Review

Use this as the only general review orchestrator for Happier. The superseded generic `review-protocol` and `code-reviewer` skills are archived and must not be invoked here; this skill absorbs their useful review categories and routes to the narrower repository skills that own testing, compatibility, diagnosis, and verification.

## 1. Normalize the request

Determine five independent values before reviewing:

1. **Target** — session, worktree, plan, feature/corridor, commit, branch/PR, bounded codebase, or release validation.
2. **Intent basis** — user request, plan, issue, PR description, ADR, or documented contract.
3. **Output mode** — `report`, `comment`, `qa`, `staged`, or `fix`.
4. **QA surfaces** — automated, browser, device, CLI/API/daemon, persistence/compatibility, platform, or release.
5. **Review class** — `advisory`, `boundary`, or `ship`.

Infer these from clear wording; ask only when the wrong target/base/mode would materially change the work or authorize writes the user did not request. Read [targets.md](references/targets.md) for target inference and mixed dirty-worktree attribution. For plan targets or plan-backed reviews, identify whether the plan is a draft under pre-approval review or an approved execution contract, then read [plan-completeness.md](references/plan-completeness.md). Do not turn an implementation-completeness audit into a second plan-design review.

Mode rules:

- `report`: review and QA only; recommendations, no source/config/test edits.
- `comment`: same as report, with concise PR-style comments backed by the full evidence record.
- `qa`: exercise the requested behavior and investigate failures without source edits or a general code-review mandate.
- `staged`: finish and present the reviewed finding/fix set, then wait for approval before source edits.
- `fix`: review, triage, implement authorized root-cause fixes, validate, and re-review.

If the request contains several example prompts with different modes, treat them as examples. Follow the user's actual requested deliverable; do not merge contradictory example clauses into one execution mode.

Review-class rules:

- `advisory`: inspect moving, dirty, partial, or completed work and report evidence-backed findings without a completeness or ship verdict;
- `boundary`: review a substantial integrated batch or plan gate and decide whether that boundary is ready to close;
- `ship`: issue a final security/data/schema/user-visible/release verdict using current deciding evidence and a different reviewer where required.

An explicit user review request is sufficient reason to review current work. Do not wait for unrelated work to stop moving; reconcile materially changed observations before a boundary or ship verdict.

## 2. Establish the review basis

Never equate the diff with the whole review scope.

- **Change basis:** exact staged, unstaged, untracked, commit, branch, PR, session-attributable, or named-feature files being judged.
- **Affected corridor:** canonical owner plus materially coupled callers, callees, producers, consumers, readers, writers, parsers, serializers, persistence, feature decisions, registries, adapters, tests/testkits, compatibility paths, and same-concept split-brains—even when unchanged.
- **Broader search:** risk-triggered searches outside the corridor for competing owners, bypasses, neighboring instances, and other consumers of changed contracts.

Classify observations as `introduced`, `exposed/activated`, `pre-existing corridor debt required for coherence`, or `unrelated observation`. Unrelated pre-existing issues do not enter the merge verdict. Read [review-standard.md](references/review-standard.md).

For architecture or cross-module relationship reviews, follow the repository Graphify instructions before raw exploration when its corpus is relevant.

## 3. Map intent, ownership, and risk before judging

Create a compact inventory before findings or QA:

- requested outcome and exclusions;
- exact change and intent basis;
- canonical owner and affected corridor;
- existing tests, harnesses, and live interfaces;
- split-brains, bypasses, legacy/compatibility paths, and removals promised;
- two or three highest-risk or quietest failure spots;
- affected user flows, states, failure/recovery paths, and compatibility directions.

Discovery is complete when those facts are sufficient to decide correctness and coverage. Do not stop early to save tokens, and do not keep retrieving optional confirmation after the material gaps are closed.

Run available deterministic inventory, schema, generated-output, formatting, type, and contract checks before spending independent semantic-review effort on the same facts. Their success is supporting evidence only; it never substitutes for behavior, architecture, security, compatibility, UX, or completeness judgment.

## 4. Select review scopes

When we talk about overengineering in review, the target is not the feature; it is the underlying implementation logic. Start from the feature's real intent and requirements, preserve those outcomes, and look for disproportionate machinery that exists only to satisfy unreal, assumed, speculative, or unreachable requirements. Test whether the implementation is the simplest design that satisfies the real requirements. Inspect whether the behavior could be satisfied by or folded into existing canonical logic through reuse, extraction, refinement, extension, consolidation, or refactoring; treat new split-brain, similar-but-different, or parallel logic as a finding when an existing owner can satisfy the need.

Always review:

- functional correctness and completeness;
- regression and blast radius;
- canonical ownership, split-brains, and bypasses;
- error/failure behavior;
- test value and validation sufficiency;
- intent/plan alignment and unjustified scope drift;
- maintainability of the changed corridor.

Activate conditional scopes only when reachable:

- security, auth, authorization, privacy, and secret handling;
- persistence, migrations, data integrity, transactions, idempotency, and concurrency;
- API/wire/CLI/IPC contracts and compatibility/version skew;
- performance, scalability, rendering, resource, or process lifecycle;
- UI/UX/accessibility and browser/device behavior;
- provider/catalog ownership;
- binary runtime, installers, packaging, services, and cross-platform behavior.

Review categories are prompts to investigate, not automatic findings. Severity follows demonstrated impact, not category. Read [review-standard.md](references/review-standard.md) for the integrated correctness, security, architecture, test, and maintainability standard.

## 5. Build the QA coverage ledger

Do not weaken QA in the name of proportionality. First enumerate the affected behavior and state space, then execute every material reachable scenario or give an evidence-backed disposition.

Across each independently observable user flow or canonical-owner contract, inventory these dimensions and exercise every materially reachable one:

1. primary success;
2. likely and high-impact failure;
3. relevant invalid/empty/boundary input;
4. repeat/retry/idempotency when applicable;
5. reload/reconnect/resume/restart and persistence when stateful;
6. auth/account/ownership isolation when protected;
7. one neighboring regression through the same owner;
8. live interface QA for user-visible behavior when runnable;
9. required released/predecessor compatibility directions;
10. platform dimensions that can materially change the result.

For a materially user-visible corridor audit, exercise the primary user-facing flow end to end when runnable or record its evidence-backed disposition. One scenario may cover several dimensions; do not duplicate equivalent rows for every minor behavior or implementation step.

Every material row ends `PASS`, `FAIL`, `BLOCKED`, `UNREACHABLE`, `OUT_OF_SCOPE` with rationale, or an explicitly authorized `DEFERRED`. Avoid irrelevant Cartesian multiplication, not relevant edge cases. Add a bounded exploratory charter after scripted flows for user-visible changes. Read [qa-coverage.md](references/qa-coverage.md) before any substantive QA.

## 6. Decompose only meaningful independent lanes

Use subagents when independent, lane-sized work improves depth or throughput—not to perform parallelism theatrically.

- Default mechanical, cartography, code-tracing, test, and QA lanes to minimal inherited conversation context (`fork_turns="none"` in Codex).
- Give a detailed self-contained lane brief: target/basis, intent, exact paths/symbols, observed evidence, risks, in/out scope, deciding checks, output path, and stop conditions.
- Point to exact shared skill/reference paths instead of pasting the full review doctrine into every prompt.
- Coordinate actual same-hunk edits, conceptual seam decisions, generated outputs, and exclusive runtime resources in fix mode. A dirty or previously touched file is not reserved; inspect its current content and layer compatible in-scope changes without overwriting concurrent work.
- Lane agents own only their assigned reports/evidence when a durable workspace exists. The orchestrator alone updates the main tracking document and adjudicates findings.
- Do not create a cartography pass when the orchestrator can map the scope cheaply.
- Do not launch another reviewer merely to turn a hunch into consensus; require an independent evidence path.

Read [orchestration.md](references/orchestration.md) whenever delegation is used. Use `skills/decompose-gates` for hard lane boundaries. Check routine lane outputs with deciding scripts, tests, diffs, and focused source inspection; use `skills/verify-claims` for decision-material delegated claims consolidated at the applicable boundary.

## 7. Review, verify, and triage

Review changed behavior first, while reading as much unchanged corridor code as correctness requires. When a durable workspace exists, store bulky logs and inventories there; otherwise keep tool output bounded to summaries plus decisive excerpts without creating ad-hoc artifacts.

Review may begin against moving, dirty, partial, or completed work. Record a concise observed basis: applicable plan revision, current HEAD and dirty-state acknowledgement, relevant paths/symbols/flows, checks run, and runtime artifact when relevant. Advisory review can report defects, emerging split-brains, incomplete wiring, unsafe direction, or plan drift without claiming completeness. Boundary and ship verdicts reconcile only materially affected observations that changed during the review; never freeze, hash, lease, manifest, or globally snapshot the worktree for review orchestration.

Authors perform compact in-place self-review during implementation without creating a formal review program. Formal independent review is normally batched at substantial integrated boundaries, explicit user-requested review points, and high-risk triggers that cannot safely wait—not after every lane, commit, gate, or microchange.

Scale review depth with reachability, user impact, reversibility, and silence of failure—not with the number of mechanisms or files. Dormant code receives one architecture/activation assessment; do not exhaustively harden it as if it were shipping. Live behavior, schema/data, security, compatibility, release, and user-visible gates retain independent risk-appropriate review.

For every candidate finding:

1. reproduce or re-derive it from primary evidence;
2. trace the real runtime/ownership path;
3. distinguish root cause from symptom and classify where the failure entered: intent/approved contract, plan design/integration, canonical implementation, test/harness, runtime/environment/external contract, or unrelated system;
4. identify concrete impact and provenance;
5. reject style preference, theoretical edge cases, and unsupported rewrites;
6. deduplicate by originating failure, root cause, and canonical owner.

Only high-confidence, objective, actionable issues become findings. Material uncertainty stays an investigation question with its falsifying check; immaterial uncertainty is discarded. Use [review-standard.md](references/review-standard.md) for the finding and comment contracts.

Any decision-material finding, refutation, or "already fixed" claim inherited from a prior report, round, or external review is re-verified against the current relevant implementation before entering a verdict. Carried claims not re-verified remain labeled assumptions; use numeric verified-N-of-M accounting only when that census itself changes the decision. A green test asserting the defective behavior is wrong-contract evidence, not acceptance; rewrite it with an authorized fix rather than citing it as protection.

Reviewers may investigate and propose any evidence-backed correction, simplification, addition, removal, mechanism, process change, or plan amendment relevant to the target. Findings are candidate claims, not implementation orders or plan authority. The orchestrator adjudicates four dimensions separately: claim (`CONFIRMED`, `REFUTED`, `INVESTIGATE`), impact (`MATERIAL`, `IMMATERIAL`, `UNRELATED`), proposed response (`ACCEPT`, `REPLACE_WITH_SIMPLER_FIX`, `DEFER`, `REJECT`), and authority (`WITHIN_PLAN`, `AMENDMENT_REQUIRED`, `OUT_OF_SCOPE`). A mechanism-sized response still requires a reproduced failure, reachable risk, or named live consumer.

After accepted fixes, review the changed finding delta and affected corridor. Restart a full round only when the approved contract, architecture, scope, review boundary, or risk materially changed. If repeated rounds keep finding hazards created by the proposed mechanism, stop hardening it and run a deletion/simplification or redesign test.

## 8. Fix coherently when authorized

In `fix` mode, or after approval in `staged` mode:

- cluster accepted findings by root cause/canonical owner rather than mechanically one fix per comment;
- execute accepted change clusters through `skills/happier-implement`, including its bug-fix loop when the cause is not already established;
- use `skills/happier-compatibility` for released/predecessor seams;
- use `skills/happier-diagnose` only when a runtime/session/provider/auth incident requires its support evidence workflow;
- rerun the affected QA rows and risk-appropriate broader lanes;
- re-review the changed corridor for regressions, split-brains, and complexity added by the fix.

For approved plan-backed work, a finding does not authorize deviation from the plan. If the root-cause fix would materially change an approved requirement, mark it `AMENDMENT_REQUIRED`, document the evidence and smallest proposed amendment, and wait for user approval before implementing that deviation.

Never edit implementation files in `report` or `comment` mode.

## 9. Boundary and ship closeout

Before a non-trivial boundary or ship verdict:

1. run `skills/attack-conclusion` against alternative causes, neighboring cases, blast radius, environment gap, hypothesis lock, split-brains, and compatibility provenance;
2. use `skills/verify-claims` for decision-material delegated claims consolidated at this boundary;
3. use autoreview only when the approved boundary, explicit user request, or risk-selected closeout calls for an advisory independent diff reviewer—not automatically after each vertical or microchange;
4. require a reviewer different from the author of the reviewed vertical for release, schema/data, security-critical, and user-visible ship gates; require a wholly separate validation session only when release or security policy says so;
5. audit whether the QA ledger itself omitted any affected material flow—not only whether existing rows passed.

Route explicit release sign-off to the release-validation owner; do not recreate its release evidence protocol here.

## 10. Tracking, evidence, and completion

Use no workspace unless the user requested durable tracking or the review is long-lived, multi-lane, plan-wide, substantively QA-heavy, or has evidence too bulky to manage safely in the handoff. A plan-wide program reuses its canonical plan QA matrix and at most one review workspace for each substantial integrated boundary; sublanes, findings, fixes, and reruns contribute evidence to that record rather than creating parallel ledgers or per-lane workspaces. When one of those conditions holds and the boundary has no existing workspace, bootstrap one isolated ignored workspace:

```bash
node skills/happier-review/scripts/bootstrap-review.mjs --slug <short-slug> --target <target> --mode <mode> --class <advisory|boundary|ship> --path <relevant-path>
```

Read [tracking-and-evidence.md](references/tracking-and-evidence.md) and [output-modes.md](references/output-modes.md) before creating or updating artifacts. Never put credentials in review artifacts; supplied development access stays runtime-only. Do not assume managed services hot-reload changes or restart/stop them without authorization—attest the actual loaded bundle/binary/revision when it matters.

A review is complete only when:

- every item in the explicit change basis is reviewed or excluded with rationale;
- the affected corridor and canonical owner are established;
- every material plan outcome/invariant, when applicable, has an evidence-backed status;
- every material QA row has a final disposition and evidence;
- every accepted finding is verified, deduplicated, and assigned a root-cause fix or explicit decision;
- no decision-material question or suspected issue is silently unresolved;
- independent closeout required by risk has completed;
- unreviewed surfaces, failed/skipped checks, blockers, and residual risks are prominent.

Use `skills/handoff-report`: outcome and blockers first, evidence-pointed findings next, coverage and rejected findings after, residual risk and exact next action last. Never claim “all flows,” “the full codebase,” or “the plan is complete” without an auditable coverage basis. A review may be final for its explicit target and observed basis while still naming unexamined surfaces and residual risk.
