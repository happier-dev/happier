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
- When the repository constitution defines a successor-line obligation, include a destination disposition in the complete outcome. Work on and validate one coherent source batch first, then invoke the owning port workflow once at that boundary. Reuse current-basis diagnosis and port evidence, and revisit only changed intents unless scope, ownership, or architecture materially changed; do not port or reanalyze the destination during every source edit.

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

When we talk about overengineering during implementation, the target is not the feature; it is the underlying logic. Start from the feature's real intent and requirements, preserve those outcomes, and implement the simplest logic that satisfies them. Do not invent disproportionate machinery for unreal, assumed, speculative, or unreachable requirements. Before adding logic, inspect whether the behavior can be satisfied by or folded into existing canonical logic through reuse, extraction, refinement, extension, consolidation, or refactoring; do not create a split-brain, similar-but-different, or parallel path when an existing owner can satisfy the need.

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

If a successor-line port is required, source validation alone is not completion. Before closeout, require an evidence-backed destination disposition for every source intent and deciding destination validation for every applicable change. An unavailable destination blocks only the port portion and must be reported explicitly; it does not invalidate completed source analysis or source validation.

## 9. Review and correct at useful boundaries

Continuously perform compact author self-review without creating a separate review program. Inspect bypasses, split-brains, neighboring cases, environment gaps, and complexity introduced by the change; run `skills/attack-conclusion` before a non-trivial handoff.

Use `skills/happier-review` for an explicit review request, a substantial integrated boundary, a risk-selected independent gate, or a review-plus-fix loop. Review findings are candidate claims. Re-derive accepted findings, separate defect from proposed mechanism, and cluster fixes by originating cause and canonical owner.

After a fix batch, recheck the accepted-finding delta and affected corridor. Repeat a full review only when the contract, architecture, scope, boundary, or risk materially changed.

## 10. Close from evidence

For work linked to a GitHub issue, keep the source correction, commit relationship, public response, release availability, and issue closure as distinct facts:

- preserve unrelated work and form one coherent correction per commit; one correction may resolve several issues, while one issue may legitimately require several commits;
- select exact paths or hunks when committing in a dirty worktree, and keep the defining regression test with the behavior it proves;
- use `Refs #N` for partial fixes, mitigations, release-gated corrections, or work that should leave the issue open;
- use `Fixes #N` only when integration into the default branch satisfies the issue's actual closure gate; because `dev` is the default branch, a closing keyword can close an issue before preview or stable users receive the correction;
- inspect the issue author and comments for material contributions embodied in the correction. A supplied causal insight, decisive reproduction, design, patch, or substantially adopted solution earns a verified `Co-authored-by: Name <email>` trailer on each commit that incorporates it; a routine report, requested log, confirmation, or generic suggestion does not automatically earn code co-authorship;
- resolve the contributor's GitHub-associated email or GitHub-provided noreply identity before committing. Never put an `@handle` in the trailer, guess or expose a private email, silently drop an unresolved attribution candidate, or let attribution change the independently selected `Refs`/`Fixes` relationship;
- after implementation, propose a Conventional Commit message and a detailed GitHub response grounded in the verified cause, owner-level correction, choices, tests, public provenance, current stage, and reporter-channel follow-up;
- do not apply labels, post comments, or close the issue without the separate exact mutation preview and approval required by `skills/happier-github-ops`.

When the complete correction is integrated and verified on canonical `dev`, include `stage:source` for every affected open issue in the next exact GitHub mutation preview. Omit it only when the issue already has the same or a higher verified stage, or the evidence-backed disposition establishes that no correction exists to release; state that reason explicitly. If mutation authority is absent, report the pending proposal instead of applying it or silently leaving the issue outside the release queue. Local 0.2 work, an open pull request, or an unmerged commit does not qualify. Normal release workflows advance later labels; implementation agents do not predict or pre-advance channels.

Keep human handoff separate from availability. After a source correction, choose among three states: retain `needs:maintainer` only when a named project-side review, diagnosis, implementation, or engineering correction remains; use `needs:reporter` when an approved public request makes external confirmation or diagnostics the next decision-material human input, even if the reporter must first wait for a named release stage; or clear both when only merge/release progression, promotion, publication, release-owned certification, backlog scheduling, or eventual closure remains. `stage:*` records the release prerequisite. Do not use `needs:maintainer` as a generic release-queue marker, and do not use hidden saved-reply directives in an agent-authored comment to bypass the exact mutation preview.

Use these outcomes:

- `VERIFIED_COMPLETE`: the real owner, wiring, removals, tests, broader checks, and required live evidence establish the complete outcome;
- `IMPLEMENTED_NOT_VERIFIED`: implementation is present but a decision-material behavior surface was not exercised;
- `PARTIAL`: authorized work remains;
- `BLOCKED`: a named prerequisite, authority, or external state prevents safe completion.

Do not claim completion because files exist, code compiles, agents stopped, checkboxes changed, or a subset of tests passed. Report through `skills/handoff-report`: outcome first, checks actually run, failed/skipped evidence, and residual risk.
