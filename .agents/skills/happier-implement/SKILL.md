---
name: happier-implement
description: Implement, change, build, fix, refactor, migrate, or apply accepted review findings in the Happier repositories with canonical-owner discovery, scope-preserving solution economy, TDD, efficient execution, affected-corridor completeness, risk-appropriate QA, and evidence-backed closeout. Use for repository source changes whether or not they are backed by an approved plan; pair with happier-implement-plan when executing an approved repository plan.
---

# Happier Implement

Implement the requested outcome through the real owner and consumed runtime path. This skill owns the common change workflow; it does not create plans, authorize plan deviations, conduct a review-only program, or turn a diagnosis request into source edits.

## 1. Normalize the change and authority

Classify the requested work as a feature/change, bug fix, refactor/migration, mechanical transformation, or accepted review fix. Confirm that the user requested implementation rather than assessment, diagnosis, planning, or review only.

- For an approved plan, also use `.agents/skills/happier-implement-plan`; that skill supplies the authoritative contract, execution units, state, and amendment rules.
- For an accepted review finding, preserve the review's adjudicated impact and authority, then choose the coherent implementation rather than copying the reviewer's proposed mechanism blindly.
- For a runtime/session/provider/auth investigation without source changes, use `.agents/skills/happier-diagnose`.
- For read-only GitHub issue grouping or diagnosis, use `.agents/skills/happier-issue-triage` and `.agents/skills/happier-issue-diagnose`. Enter this implementation workflow only after the user authorizes source changes, carrying forward the established issue evidence and version basis.
- For a reported defect or regression, read [bug-fix-loop.md](references/bug-fix-loop.md) before editing production behavior.

Do not create a repository plan on agent initiative. Use an internal checklist when useful, but keep it ephemeral unless an approved program already designates durable tracking.

## 2. Establish the complete outcome backward

State the real intent, exclusions, and outermost observable result. Derive the implementation backward:

1. name the user-visible, operational, compatibility, and architectural truths that must hold;
2. identify the canonical owners or artifacts that establish each truth;
3. identify the real entry points, consumers, wiring, migrations, removals, and compatibility paths required to make those owners authoritative — list every lifecycle entry that reaches the owner (each surface, fresh load, restart/native startup, reconnect, each credential mode) and route each through it, because an entry that bypasses an existing owner was the most common live defect in the Voice program;
4. identify the two or three links whose failure would be most damaging or least visible;
5. choose deciding evidence that observes the truths at the outermost practical contract surface.

Imports, registrations, types, file existence, mocked wiring, and helper tests are supporting evidence. They do not complete a user flow, CLI/API contract, persisted-state transition, process lifecycle, provider integration, or published artifact when that real surface is runnable.

Preserve every authorized outcome: integration, migration, removals, compatibility, UX, accessibility, security, privacy, performance, platform behavior, testing, and validation. Solution economy simplifies the implementation inside that boundary; it never reduces the boundary.

## 3. Discover the current owner and affected corridor

Before production changes, inspect enough current evidence to name:

- the canonical owner and why the behavior belongs there;
- inputs, normalization, callers, producers, consumers, readers, writers, and user-visible outputs;
- state, persistence, lifecycle, schema, feature, provider, compatibility, and platform seams that are materially coupled;
- existing tests, testkits, live recipes, and generated outputs;
- same-concept split-brains, bypasses, legacy paths, parallel decisions, and planned removals;
- current relevant diff and compatible uncommitted work that must be preserved.

Search by symbols and domain identifiers, not filenames alone. Stop once the material owner, corridor, risks, and deciding checks are established; do not keep searching for reassurance.

**New actor checklist.** When work runs for someone other than the Machine/Account owner (guest, requester, or agent acting for a user), enumerate every follow-up call—get, cancel, recovery, publication, transcript follow, storage writes and settlement—and state whose authority each uses at the one owner that selects credentials. Why: successful admission does not prove later calls use the right bearer (FIN row 8e, 2026-11-02–04).

Dirty or concurrently edited files are normal and do not establish ownership. Inspect current bytes, preserve compatible changes, and layer in-scope work on top. Coordinate only actual same-hunk edits, incompatible decisions at one conceptual seam, destructive moves, single-producer generated outputs, or exclusive runtime resources.

## 4. Select the smallest coherent systemic change

Apply root **Scope-preserving solution economy** at implementation time: preserve the complete feature outcome, challenge unsupported machinery rather than the feature itself, and fold behavior into the canonical owner through reuse, refinement, consolidation, or refactoring before adding another path.

Prefer, in order, to add nothing when the complete outcome already holds; correct/reuse/refine/consolidate the canonical owner; use the language or platform; use an existing package-owned dependency; or add the smallest clear consumed implementation.

Smallest coherent does not mean smallest diff. Update every materially affected caller, reader, writer, consumer, platform path, and compatibility direction. Remove or migrate active competing owners and bypasses when the authorized outcome makes them obsolete. Do not centralize coincidental similarity across distinct bounded contexts or absorb unrelated debt.

Before changing a shared fact or contract (shape, vocabulary, timing, readiness, acquisition, publication, error code, projection fields, geometry/policy, public prop/helper signature, union member, kind, enum or parameter type), inventory every writer and reader across packages by symbol, store slice, hook, schema and error code. Include strict-parse readers, tests/testkits and twin projections (tool list vs prompt docs, client vs daemon spelling, UI vs agent path); record one line per consumer naming its need and the test covering its distinct behaviour (consumers that read the owner's result the same way share one test), add missing coverage or explain why none is needed, update each in the same change or explain its unreachability, run existing suites importing the changed owner, and list the sweep in the handoff. Reviewers re-derive it from symbols. For a fix, audit every sibling path sharing the contract or bug class, including every write of the same credential scope or caller of the same Action operand; a reachable defective sibling makes the fix incomplete.

Before tightening schema strictness, run the released/predecessor/stored-shape census in [happier-compatibility §2](../happier-compatibility/SKILL.md#2-establish-evidence-backed-baselines).

Prefer exhaustive switches or `satisfies` checks for union consumers so the compiler names omissions; every map or list keyed by a canonical union is generated from that union, checked with `satisfies Record<Union, ...>` where applicable, or covered by an equivalence test against the canonical union. A hand-maintained subset must state its narrower domain rather than silently omitting members. Access-class lists are the same rule: RPC forwarding maps, HTTP purpose admission and custodian-only sets derive from the method's or Action's own declaration; until a list is derived, a change that adds a method names every hand list it must join (2026-11-04/06: two live omissions and one cross-person leak came from adding to one list and not the others). Generated outputs (Action DTOs, Protocol dist, manifests, lockfile) are regenerated and committed in the same packet as the producer change that alters them; a producer committed without its generated output breaks every consumer of the stale copy (2026-11-06: stale SDK DTOs blocked a 965-commit aggregate). A shared-checkout package typecheck may already be red or stop at an earlier package; it does not replace the inventory.

Failures name themselves where they happen. When a boundary step knows why it failed (HTTP status, refusal code, thrown class, missing fact), its typed result carries that step and code, secret-free, to the caller. Never convert a known cause into `unknown`, `uncertain`, `outcome_unknown`, `unknown_error` or a generic schema mismatch, and never report success or "approved" for an effect that did not happen. In the 2026-11-03/04 deploy and Vercel work, flattened causes cost one reload round each, about eight times. An unclassified failure stays a typed internal error carrying its first cause; never map it onto a domain refusal (`forbidden`, `unavailable`, `not_found`). Codeless throws use the shared unknown code (`action_failed`) through the corridor's failure owner, with a private sanitized diagnostic. Carry native and Provider typed causes through receipts and public errors; catch-all relabeling hides the failing boundary (35210f75978: 11 deploy catches; Cloudflare UnknownThrownValue, Create link_incomplete and Domain Add). A failing part degrades only its own section with its reason, never the whole surface (PR4, 2026-11-07).

Authoritative history is physically deleted only by an explicit person deletion of that history or by its retention-policy owner. Removing or stopping another resource must not select that history for deletion as a side effect. Cover the ordinary action followed by a history read through another surface in one composed test (3a517717: removing a trigger bypassed keepForever).

An Action's input is built by one owner shared by the UI, CLI and agent paths. Two builders for the same input are a split-brain, even when both currently pass their own tests.

Place code by root `AGENTS.md` "Files, folders, and moves". New behaviour goes in a focused module inside the owner's domain folder, named with the folder as context: don't restate the folder in the file name, and avoid `utils`/`helpers`/`manager`. Don't grow an already-large file. When a change touches a responsibility that lives inside one, extract that responsibility into its own sibling module as part of the change, keeping the original exports and package aliases so importers don't change. Delete what the change makes obsolete.

A user-facing mutation is wired through the Action executor when it is built. A direct transport or settings write from a UI component is a review finding. Extend the canonical walker `scripts/testing/lib/uiActionParity.ts` rather than running a census afterwards.

Every wait names the fact that ends it. A readiness gate, acquisition wait or loading state must cite the producer of its settling fact, including the absent, disabled, unreachable and failed outcomes, and a test reaches each one. A wait whose ending fact has no producer is a state that cannot end and is a defect, not a safe default; read through the existing owner instead of gating on optional inputs (a Session directory, a live daemon, a plugin declaration) the read does not need.

Security guards ship with [happier-testing's owner-positive guard test](../happier-testing/SKILL.md#seam-tests-required-when-a-change-crosses-a-seam), including admission, isolation, custody and authority changes.

Before adding a protocol, registry, table, state machine, gate, lease, generation, fallback, cache, or parallel path, apply root **Choose good compromises**: name the approved requirement, reproduced failure, external contract, or reachable risk it serves and apply the deletion test; validate at the trust boundary and trust internal data behind it.

Each fact is decided once at its owner, and consumers use its typed result. Authorization predicates live in the store or lookup accessor every caller must go through, not at each ingress. A check copied to N handlers is a split-brain waiting for handler N+1 (detached-Run ownership: RUN-OWNER-STORE). Do not add a re-check of an owner's fact in another function, process or surface; if one seems needed, fix the owner.

Do not add consumer-side retries, caches or fallbacks before reproducing the cause; fix the producer at its canonical owner. Evidence: `.project/OWNER-RULINGS.md` (10-29 guardrails); `.project/plans/2026-10-29-program-census/RESUME-DECISIONS.md` §2.

Treat every timeout, retry count, quota, request/body or collection-size cap, truncation threshold, and similar guard as an owner-level product decision. Search for the containing operation's canonical deadline or resource boundary first and reuse it; do not add a shorter phase-local cutoff or guessed "safe" number. If no real contract or measured resource failure requires a bound, add none. When one is required, keep its derivation beside the owner, preserve valid data when paging or explicit incompleteness can do so safely, make activation observable, and prove both the rejecting/timeout case and valid behavior beyond the previously tempting arbitrary cutoff.

When the change adds or alters a read, publication, subscription, timer, poll, cache, guard, pool, batch or dynamic import on a per-arrival, per-request, per-render or idle path, apply `.agents/skills/happier-performance`. Work stays proportional to real change and reads to need. Fix the producer instead of guarding the consumer. Land with its count-based cost contract and the real-Postgres or compiled-bundle check it calls for.

## 5. Shape execution for throughput

Use direct implementation for tightly coupled work and `.agents/skills/decompose-gates` for meaningful independent responsibilities. For repeated units with an unproven shared assumption, apply that skill's concurrency ramp: gate only dependent replication, keep independent work moving, and skip the ramp when prior evidence or a deterministic tool already proves the unit shape.

Delegate complete responsibilities rather than tiny edits. A lane owns its discovery, implementation, focused RED/GREEN proof, relevant validation, compact self-review, and concise result. Briefs name the goal, intent, corridor, evidence, dependencies, collision surfaces, completion and negative criteria, validation, permissions, and stop conditions. Do not reserve files or duplicate generic doctrine in every brief.

Quote product prompts and execution recipes verbatim in briefs, including instructions to send a seeded prompt unchanged; do not paraphrase away inputs or steps that determine the outcome.

Use the fastest reliable mechanism for the work:

- repository scripts and generators;
- compiler/language-server renames;
- AST-aware codemods for structural repetition;
- bounded structured replacement for uniform text/configuration;
- formatters and deterministic validators;
- batched retrieval with compact output.

Before parking, identify the exact missing producer and its current owner, then recheck current source and the authoritative completion event. If the producer is unowned, necessary and within the approved scope, claim it at the existing owner and implement that consumed vertical. Otherwise name the external owner, decision or authority needed. Park only the dependent work, with a named resume trigger, and resume the existing lane when that trigger arrives. When a packet is refused for a foreign uncommitted producer, post an ASK to that producer's lead at once naming the path and symbol, rather than parking silently. Never park on a decision that belongs to your own orchestrator (commit grouping, fixture recreation) or on a producer RESULT that already names your next step: route the question to your orchestrator and keep working (RU2, 2026-11-06: about 5 h lost this way in one day).

Preview broad transformations, establish their match set, inspect representative and aggregate diffs, and validate omissions plus unintended matches. Do not build tooling when a few direct edits are safer and faster.

Each generated-output family has one canonical regeneration command; its drift guard points to that command instead of only refusing stale output. A spec owner may run that writer under its existing publication lock, then run the governance check; verify the lock exists first, otherwise name the gap and coordinate with the publication owner rather than creating a second writer.

## 6. Resolve uncertainty with evidence

Uncertainty is an investigation task, not a reason to skip in-scope work. Classify the missing answer first: if source, history, a focused prototype, test, schema, log, measurement, runtime state, artifact, or current primary documentation can decide it safely, retrieve that evidence. Ask only for a genuine product, preference, authority, or tradeoff decision evidence cannot settle, unavailable external state, or material expansion/redesign. Continue independent work that cannot prejudge that decision.

## 7. Implement through a valid test and real path

- Use `.agents/skills/happier-testing`. Production behavior changes require meaningful RED for the intended observable contract, minimal coherent GREEN, then refactoring with tests green.
- When an approved decision changes behaviour, apply [happier-testing's same-change expectation rule](../happier-testing/SKILL.md#workflow), citing that decision; obsolete expectations escaped in glass, Machine badge, Share and picker/read-count tests (UI refinements, 2026-11-04).
- Mock only genuine system boundaries; keep internal domain behavior real.
- Implement through the canonical/public owner boundary and a consumed path, not a dormant horizontal spine.
- Add a consumer only with its producer's export, schema, migration, registration or declaration available. For removals/renames of shared exports, specs and Actions, migrate consumers first and remove the producer last in one atomic edit batch; retain temporary compatibility exports if work must stop midway. Load-check once before hand-off, never per edit, under root **Multi-agent and Git safety** "Leave shared source loadable". Incident basis: `.project/plans/2026-10-29-program-census/RESUME-DECISIONS.md` §2 (10-29 shared-package load break).
- Use `.agents/skills/happier-compatibility` for released wire, semantic, persistence, migration, upgrade, coexistence, or rollback seams.
- Follow the 2026-10-31 **Migrations: no edits during development, one consolidation before 0.3 release** row in `.project/OWNER-RULINGS.md` for migration authoring, the named release check and accidental-edit reconciliation; the reconciliation procedure is in `apps/stack/AGENTS.md` **Repo-local development database reconciliation**. A source-level or clean migration test does not replace required in-place reconciliation.
- Use relevant UI/design/React/React Native skills for user-facing work under `DESIGN.md` and package instructions.
- Before fixing UI behaviour, apply [happier-testing's live-first reproduction and frame evidence](../happier-testing/SKILL.md#live-validation-gates).
- Preserve performance, continuity, accessibility, security, privacy, and Windows/Linux/macOS behavior wherever the changed corridor can materially differ.
- A failure that crosses a process, package or transport boundary carries its closed reason code, phase and retryability from the producer to one presenter. Never carry payloads or content in that failure metadata. Wrappers keep the canonical code rather than re-wrapping it into a generic `unavailable`, `unknown` or `invalid_parameters`. A sanitizer or redactor removes content only; it keeps the code and phase (on 2026-11-03/04 a sanitized native startup error reduced every member-Codex failure to "reason unknown" and cost six QA reload rounds). Readers that can't decide return an explicit unknown variant, never a negative fact. Callers never loop on a non-retryable code. The deciding test asserts the code at the outermost consumer, plus one "non-retryable code → settles with zero re-polls" case.

In delivery/queue pipelines, every skip or `continue` records a settled decision or an explicit hold with its release trigger. Acknowledge a request or intent as consumed only after its effect is applied.

Classify unexpected failures before changing code: production defect, test drift, harness drift, environment/resource failure, external-contract change, or unrelated failure. A green test is invalid evidence when the harness suppresses errors, mocks away the deciding path, or asserts the defective contract.

## 8. Validate the outcome, not implementation presence

Run the narrowest deciding GREEN check, then broaden according to reachability, silence of failure, blast radius, and reversibility. Exercise relevant happy, edge, failure, cancellation, recovery, persistence, compatibility, platform, and neighboring-owner behavior without manufacturing Cartesian matrices.

Report verification gates per item, preserving each item's pass, failure or blocked prerequisite rather than marking an entire batch failed because one item failed.

For each execution unit crossing a seam, apply [happier-testing's composed entry-to-output and registration-parity rules](../happier-testing/SKILL.md#seam-tests-required-when-a-change-crosses-a-seam).

When the fix is for a failure seen in live QA on a host, OS-identity, credential or platform boundary, and the fixing lane can reach that host, it reruns the failing recipe step there itself before handing back. A probe that omits the user's real inputs (for example no connected credentials) does not count.

Before handing back any fix, walk the rest of the user journey past the corrected step in-process or in a composed test. A fix is done only when its root cause is corrected at the owner, the sibling-path audit above is complete, and that journey succeeds.

For user-visible or environment-dependent changes, run the composed live browser/device/CLI/API/daemon recipe against the relevant loaded source/build when authorized and available. If that proof cannot run, use `IMPLEMENTED_NOT_VERIFIED` and name the missing prerequisite; do not substitute more internal checks and claim completion.

Do not guess an expected result that cannot be derived from the user request, approved plan when applicable, current external contract, or observed canonical behavior. Distinguish implementation missing/wrong, implementation present but behavior unverified, evidence unavailable, and expected behavior materially ambiguous.

## 9. Review and correct at useful boundaries

Continuously perform compact author self-review without creating a separate review program: it is `.agents/skills/attack-conclusion`'s one self-simplification pass, run as you go and in full before a non-trivial handoff.

Use `.agents/skills/happier-review` for an explicit review request, a substantial integrated boundary, a risk-selected independent gate, or a review-plus-fix loop. Review findings are candidate claims. Re-derive accepted findings, separate defect from proposed mechanism, and cluster fixes by originating cause and canonical owner.

After a fix batch, recheck only the accepted-finding delta and paths needed to verify it. After three fixes on one owner, stop before a fourth patch and run [happier-review's intent mode](../happier-review/references/intent-review.md) on the whole owner. Repeat a full review only when the contract, architecture, scope, boundary, or risk materially changed.

## 10. Close from evidence

Report verification as four separate facts: source landed; built/published declarations fresh; loaded in an identified runtime; live journey or whole page observed. Never infer a later fact from an earlier one.

For work linked to a GitHub issue, keep the source correction, commit relationship, public response, release availability, and issue closure as distinct facts:

- preserve unrelated work and form one coherent correction per commit; one correction may resolve several issues, while one issue may legitimately require several commits;
- select exact paths or hunks when committing in a dirty worktree, and keep the defining regression test with the behavior it proves;
- use the checkout's existing current-user Git identity for ordinary commits; never replace it with the bot or a contributor identity, and keep contributor credit in commit-specific verified trailers;
- use `Refs #N` for partial fixes, mitigations, release-gated corrections, or work that should leave the issue open;
- use `Fixes #N` only when integration into the default branch satisfies the issue's actual closure gate; because `dev` is the default branch, a closing keyword can close an issue before preview or stable users receive the correction;
- inspect the issue author and comments for material contributions embodied in the correction. A supplied causal insight, decisive reproduction, design, patch, or substantially adopted solution earns a verified `Co-authored-by: Name <email>` trailer on each commit that incorporates it; a routine report, requested log, confirmation, or generic suggestion does not automatically earn code co-authorship;
- resolve the contributor's GitHub-associated email or GitHub-provided noreply identity before committing. Never put an `@handle` in the trailer, guess or expose a private email, silently drop an unresolved attribution candidate, or let attribution change the independently selected `Refs`/`Fixes` relationship;
- after implementation, propose a Conventional Commit message and a detailed GitHub response grounded in the verified cause, owner-level correction, choices, tests, public provenance, current stage, and reporter-channel follow-up;
- do not apply labels, post comments, or close the issue without the exact or bounded standing mutation authority required by `.agents/skills/happier-github-ops`.

When the complete correction is integrated and verified on canonical `dev`, include `stage:source` for every affected open issue in the next authorized GitHub mutation. Omit it only when the issue already has the same or a higher verified stage, or the evidence-backed disposition establishes that no correction exists to release; state that reason explicitly. Under exact authorization, include it in the preview; under a standing grant that covers issue labels, apply and report it without another prompt. If mutation authority is absent, report the pending proposal instead of applying it or silently leaving the issue outside the release queue. Local work, `../0.2`, an open pull request, or an unmerged commit does not qualify. Normal release workflows advance later labels; implementation agents do not predict or pre-advance channels.

Keep human handoff separate from availability. After a source correction, choose among three states: retain `needs:maintainer` only when a named project-side review, diagnosis, implementation, or engineering correction remains; use `needs:reporter` when an authorized public request makes external confirmation or diagnostics the next decision-material human input, even if the reporter must first wait for a named release stage; or clear both when only merge/release progression, promotion, publication, release-owned certification, backlog scheduling, or eventual closure remains. `stage:*` records the release prerequisite. Do not use `needs:maintainer` as a generic release-queue marker, and do not use hidden saved-reply directives to manufacture mutation authority.

Before choosing an outcome, check the closing questions and answer each in the handoff:

- every user-visible capability added or changed has its Action with the plan's approval default, and `scripts/testing/lib/uiActionParity.ts` finds no UI mutation that bypasses the Action executor;
- each new persisted value lives where root `AGENTS.md` places it, never in settings unless a person changes it deliberately;
- ingress coverage satisfies [happier-testing's ingress rule](../happier-testing/SKILL.md#seam-tests-required-when-a-change-crosses-a-seam);
- each new producer, timer or poll satisfies [happier-performance's landing checks](../happier-performance/SKILL.md#3-landing-checks-for-a-perf-relevant-change);
- any plugin SDK or `@happier-dev/plugin-ui` seam that grew has its plugin-author example and published-docs update;
- user-visible pages were compared whole against their lab or reference in light, dark and phone, and the program's journey step was exercised on the loaded runtime;
- every mechanism this change added passes the deletion test, the handoff states the net mechanism delta (`+added / −removed`), and it says how far the work is from complete.

Use these outcomes:

- `VERIFIED_COMPLETE`: the real owner, wiring, removals, tests, broader checks, and required live evidence establish the complete outcome;
- `IMPLEMENTED_NOT_VERIFIED`: implementation is present but a decision-material behavior surface was not exercised;
- `PARTIAL`: authorized work remains;
- `BLOCKED`: a named prerequisite, authority, or external state prevents safe completion.

Do not claim completion because files exist, code compiles, agents stopped, checkboxes changed, or a subset of tests passed. Report through `.agents/skills/handoff-report`: outcome first, checks actually run, failed/skipped evidence, and residual risk.
