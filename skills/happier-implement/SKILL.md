---
name: happier-implement
description: Implement, change, build, fix, refactor, migrate, or apply accepted review findings in the Happier repositories with canonical-owner discovery, scope-preserving solution economy, TDD, efficient execution, affected-corridor completeness, risk-appropriate QA, and evidence-backed closeout. Use for repository source changes whether or not they are backed by an approved plan; pair with happier-implement-plan when executing an approved repository plan.
---

# Happier Implement

Implement the requested outcome through the real owner and consumed runtime path. This skill owns the common change workflow; it does not create plans, authorize plan deviations, conduct a review-only program, or turn a diagnosis request into source edits.

## 1. Normalize the change and authority

Classify the requested work as a feature/change, bug fix, refactor/migration, mechanical transformation, or accepted review fix. Confirm that the user requested implementation rather than assessment, diagnosis, planning, or review only.

- For an approved plan, also use `skills/happier-implement-plan`; that skill supplies the authoritative contract, execution units, state, and amendment rules.
- For an accepted review finding, preserve the review's adjudicated impact and authority, then choose the coherent implementation rather than copying the reviewer's proposed mechanism blindly.
- For a runtime/session/provider/auth investigation without source changes, use `skills/happier-diagnose`.
- For read-only GitHub issue grouping or diagnosis, use `skills/happier-issue-triage` and `skills/happier-issue-diagnose`. Enter this implementation workflow only after the user authorizes source changes, carrying forward the established issue evidence and version basis.
- For a reported defect or regression, read [bug-fix-loop.md](references/bug-fix-loop.md) before editing production behavior.

Do not create a repository plan on agent initiative. Use an internal checklist when useful, but keep it ephemeral unless an approved program already designates durable tracking.

## 2. Establish the complete outcome backward

State the real intent, exclusions, and outermost observable result. Derive the implementation backward:

1. name the user-visible, operational, compatibility, and architectural truths that must hold;
2. identify the canonical owners or artifacts that establish each truth;
3. identify the real entry points, consumers, wiring, migrations, removals, and compatibility paths required to make those owners authoritative;
4. identify the two or three links whose failure would be most damaging or least visible;
5. choose deciding evidence that observes the truths at the outermost practical contract surface.

Imports, registrations, types, file existence, mocked wiring, and helper tests are supporting evidence. They do not complete a user flow, CLI/API contract, persisted-state transition, process lifecycle, provider integration, or published artifact when that real surface is runnable.

Preserve every authorized outcome: integration, migration, removals, compatibility, UX, accessibility, security, privacy, performance, platform behavior, testing, and validation. Solution economy simplifies the implementation inside that boundary; it never reduces the boundary.

## 3. Discover the current owner and affected corridor

Before production changes, inspect enough current evidence to name:

- the canonical owner and why the behavior belongs there;
- inputs, normalization, callers, producers, consumers, readers, writers, and user-visible outputs;
- state, persistence, lifecycle, schema, feature, provider, compatibility, and platform seams that are materially coupled;
- existing tests, testkits, live recipes, and generated or packaged artifacts;
- same-concept split-brains, bypasses, legacy paths, parallel decisions, and planned removals;
- current relevant diff and compatible uncommitted work that must be preserved.

Search by symbols and domain identifiers, not filenames alone. Stop once the material owner, corridor, risks, and deciding checks are established; do not keep searching for reassurance.

Dirty or concurrently edited files are normal and do not establish ownership. Inspect current bytes, preserve compatible changes, and layer in-scope work on top. Coordinate only actual same-hunk edits, incompatible decisions at one conceptual seam, destructive moves, single-producer generated outputs, or exclusive runtime resources.

## 4. Select the smallest coherent systemic change

Prefer, in order, to add nothing when the complete outcome already holds; correct/reuse/refine/consolidate the canonical owner; use the language or platform; use an existing package-owned dependency; or add the smallest clear consumed implementation.

Smallest coherent does not mean smallest diff. Update every materially affected caller, reader, writer, consumer, platform path, and compatibility direction. Remove or migrate active competing owners and bypasses when the authorized outcome makes them obsolete. Do not centralize coincidental similarity across distinct bounded contexts or absorb unrelated debt.

Before adding a protocol, registry, table, state machine, gate, lease, generation, fallback, cache, or parallel path, name the approved requirement, reproduced failure, external contract, or reachable risk it serves. Apply the deletion test. If the mechanism only adds concepts while required behavior survives without it, do not build it.

## 5. Shape execution for throughput

Use direct implementation for tightly coupled work. Use `skills/decompose-gates` when the work contains meaningful independent responsibilities, then keep the critical path supplied with ready implementation, QA preparation, deterministic migration, and validation work.

Delegate complete responsibilities rather than tiny edits. A lane owns its discovery, implementation, focused RED/GREEN proof, relevant validation, compact self-review, and concise result. Briefs name the goal, intent, corridor, evidence, dependencies, collision surfaces, completion and negative criteria, validation, permissions, and stop conditions. Do not reserve files or duplicate generic doctrine in every brief.

Use the fastest reliable mechanism for the work:

- repository scripts and generators;
- compiler/language-server renames;
- AST-aware codemods for structural repetition;
- bounded structured replacement for uniform text/configuration;
- formatters and deterministic validators;
- batched retrieval with compact output.

Preview broad transformations, establish their match set, inspect representative and aggregate diffs, and validate omissions plus unintended matches. Do not build tooling when a few direct edits are safer and faster.

## 6. Resolve uncertainty with evidence

Uncertainty is an investigation task, not a reason to skip in-scope work. Name the missing fact and the observation that would decide it, then inspect the smallest useful combination of source, history, tests, schemas, logs, runtime state, artifacts, or current primary documentation.

Ask only when safe investigation cannot resolve a decision-material ambiguity, user authority is required, external state is unavailable, or the requested outcome would need material expansion or redesign. Continue independent work that cannot prejudge that decision.

## 7. Implement through a valid test and real path

- Use `skills/happier-testing`. Production behavior changes require meaningful RED for the intended observable contract, minimal coherent GREEN, then refactoring with tests green.
- Mock only genuine system boundaries; keep internal domain behavior real.
- Implement through the canonical/public owner boundary and a consumed path, not a dormant horizontal spine.
- Use `skills/happier-compatibility` for released wire, semantic, persistence, migration, upgrade, coexistence, or rollback seams.
- Use relevant UI/design/React/React Native skills for user-facing work under `DESIGN.md` and package instructions.
- Preserve performance, continuity, accessibility, security, privacy, and Windows/Linux/macOS behavior wherever the changed corridor can materially differ.

Classify unexpected failures before changing code: production defect, test drift, harness drift, environment/resource failure, external-contract change, or unrelated failure. A green test is invalid evidence when the harness suppresses errors, mocks away the deciding path, or asserts the defective contract.

## 8. Validate the outcome, not implementation presence

Run the narrowest deciding GREEN check, then broaden according to reachability, silence of failure, blast radius, and reversibility. Exercise relevant happy, edge, failure, cancellation, recovery, persistence, compatibility, platform, and neighboring-owner behavior without manufacturing Cartesian matrices.

For user-visible or environment-dependent changes, run the composed live browser/device/CLI/API/daemon recipe against the relevant loaded build or artifact when authorized and available. If that proof cannot run, use `IMPLEMENTED_NOT_VERIFIED` and name the missing prerequisite; do not substitute more internal checks and claim completion.

Do not guess an expected result that cannot be derived from the user request, approved plan when applicable, current external contract, or observed canonical behavior. Distinguish implementation missing/wrong, implementation present but behavior unverified, evidence unavailable, and expected behavior materially ambiguous.

## 9. Review and correct at useful boundaries

Continuously perform compact author self-review without creating a separate review program. Inspect bypasses, split-brains, neighboring cases, environment gaps, and complexity introduced by the change; run `skills/attack-conclusion` before a non-trivial handoff.

Use `skills/happier-review` for an explicit review request, a substantial integrated boundary, a risk-selected independent gate, or a review-plus-fix loop. Review findings are candidate claims. Re-derive accepted findings, separate defect from proposed mechanism, and cluster fixes by originating cause and canonical owner.

After a fix batch, recheck the accepted-finding delta and affected corridor. Repeat a full review only when the contract, architecture, scope, boundary, or risk materially changed.

## 10. Close from evidence

Use these outcomes:

- `VERIFIED_COMPLETE`: the real owner, wiring, removals, tests, broader checks, and required live evidence establish the complete outcome;
- `IMPLEMENTED_NOT_VERIFIED`: implementation is present but a decision-material behavior surface was not exercised;
- `PARTIAL`: authorized work remains;
- `BLOCKED`: a named prerequisite, authority, or external state prevents safe completion.

Do not claim completion because files exist, code compiles, agents stopped, checkboxes changed, or a subset of tests passed. Report through `skills/handoff-report`: outcome first, checks actually run, failed/skipped evidence, and residual risk.
