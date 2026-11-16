---
name: happier-plan
description: Use only when the current user explicitly asks to create, replace, materially refine, or record an approved amendment to a Happier repository implementation plan.
---

# Happier Plan

Create a repository plan only on an explicit current-user request. Planning is a human-controlled product/design decision, not an agent-selected prerequisite. Do not invoke this skill to implement an existing plan, update ordinary execution status, review completed work, or create an internal ephemeral checklist.

## 1. Establish authorization and mode

Classify the explicit request as one of:

- `CREATE`: author a new repository plan;
- `REFINE`: materially change a draft or approved plan as the user requested;
- `REPLACE`: supersede an existing plan with a user-requested successor;
- `AMEND`: record a user-approved change to an approved execution contract.

If the user did not explicitly request one of these, do not create or materially edit a plan file. A reviewer or implementation agent may recommend a plan/amendment, but only the user can authorize creating it or changing its approved contract. A successor references its predecessor and explicitly preserves, changes, or retires still-applicable material decisions; do not mechanically transcribe historical tasks, findings, or markers.

A cleanup plan produced by an owner-approved intent campaign is approved by default when it follows that campaign's approved rules (`.project/OWNER-RULINGS.md`, 2026-10-29; root `AGENTS.md` "Plan authority and lifecycle"). Present it as approved and raise only real product questions and the named security reviews with the owner. The grant covers those cleanup plans only, not other plans or instruction changes.

Plan authoring does not authorize implementation. If the user asked only for a plan, stop after presenting the draft. If the user requested both planning and implementation, present the plan for approval before treating it as the execution contract unless the user explicitly waived that checkpoint.

## 2. Write the gate first

A plan is a one-page gate plus free-form design below it ([references/plan-template.md](references/plan-template.md)). The gate is the only mandatory part and is written before any design prose. Derive it backward from the outcome beneath the literal request: the user-visible, operational, compatibility and architectural truths that must hold; the canonical owners that establish them; the entry points, consumers, wiring, migrations, removals and compatibility paths that make those owners authoritative; the few links whose failure would be most damaging or least visible; and deciding evidence that observes each truth at the outermost practical contract surface (evidence that distinguishes success from a plausible incomplete implementation). Name only compatibility, security, performance, accessibility, platform and rollout constraints that are actually reachable. Use stable ids (F1, M1) for flows and ledger rows in substantive plans:

1. **Flows.** The outcome beneath the literal request, then each user flow step by step with the features that must keep working and its server/daemon calls per user operation as a formula of real units (for example deploy = 1 admit + N services + 1 settle). Each formula becomes a shape test in `.agents/skills/happier-performance/references/flow-budgets.md` (`it.fails` until the units land). Shape tests assert shape and record measured counts; plans have no size cap and set no numeric call, check or mechanism budgets. Each flow also names its composed acceptance test and the fixture it starts from ([happier-testing Test Value Gate](../happier-testing/SKILL.md#test-value-gate)).
2. **Mechanism ledger.** One row per check, state, timer, retry, cache, lock, lease, receipt, limit or approval the design adds: owner (one place), user-visible harm without it, how it is reachable (reproduction, incident, named cross-person threat), the reference that does it (`repo:path`) or the Happier-specific requirement, and cost per operation. Apply root **Choose good compromises**: a row lacking harm and reachability, or lacking both a reference and a Happier-specific requirement, is deleted rather than listed. Requirements about exactness, current authority, freshness or fail-closed behavior are written only as ledger rows, as an outcome plus the one owner and place that decides it, never as "every read re-checks…" or "re-prove before every effect"; every surface that depends on that fact consumes the owner's result. Each such row names the concrete failure if approximate, prefers the domain's own revision check over another layer, and, for freshness, names its observation trigger and satisfies the idle invariant.
3. **Accepted imperfections.** Races and edge cases deliberately not handled, each with why it is visible and recoverable.
4. **Ship journey.** One composed end-to-end recipe with its loaded-runtime identity, plus the short release-checks list.
5. **Prevention.** One row per pattern in the current QA failure-pattern digest (`.project/tmp/QA-PATTERNS-1116/DIGEST.md`) that these flows can hit: pattern → the composed-test case or existing owner that prevents it. Leave out patterns the flows cannot hit; no prose.
6. **Placement.** For a new capability or material feature growth, record `KEEP CORE`, `PLUGIN` or `SPLIT` with its owner. Optional products and integrations default to `PLUGIN` when the existing SDK covers them (contributions, Actions, pages/settings, Account Collections, background services, demand activation). `KEEP CORE` names the shared primitive and its current consumers; "already in core" or "has a table" is not a reason. A missing SDK contract names the consuming flow that needs it. State what a user who never enables the feature still loads, subscribes to or runs. Bundled plugins follow external-plugin rules. Do not add a framework, second owner or plugin fence for this. Mechanical or content changes: "n/a".

Separate observed facts, derived conclusions, assumptions, and unresolved user decisions. Resolve decision-material ambiguity before finalizing a design; do not bury it as an implementation detail. Include a constraint only when it excludes or materially changes a plausible implementation. Convert vague qualities such as “robust,” “clean,” “premium,” or “scalable” into an observable contract, deciding principle, or acceptance signal; otherwise omit the decorative wording. State the user need behind every geometric or behavioural constraint ("the viewer never covers content", "at most N") and plan for the need when it is narrower than the constraint.

Do not promote an architectural possibility, speculative future consumer, generalized reuse opportunity, another proposed mechanism, or unsupported robustness/scalability target into a requirement. Establish requirements from an approved outcome, constitution rule, external contract, reproduced failure, or reachable derived risk.

## 3. Investigate the current system

Before selecting the target shape, inspect enough current code and evidence to name:

- the canonical owner and why it owns the behavior;
- real entry points, callers, producers, consumers, readers, and writers;
- current schemas, persistence, lifecycle, feature decisions, compatibility seams, and external contracts;
- existing tests, testkits, live QA surfaces, and platform-specific paths;
- existing, similar, competing, legacy, bypass, or split-brain implementations in the affected corridor;
- overlapping active plans/programs and their `Supersedes:`, `Extends:`, or `Consumes:` relationships;
- the two or three highest-risk or quietest failure points.

Before a ruling, redesign or new mechanism, inventory what already exists for that concept with `file:line`: owners, records, fields, Actions, UI flows and the shipped features of any surface being redesigned. A fact relayed to the user or written into a ruling is read at the code path or vendor documentation that decides it; a field's presence is not proof that the behavior is implemented. Reference projects supply proposals to evaluate, never requirements, and their names never appear in Happier code, copy or identifiers.

Search broadly enough to establish these facts, then stop. Do not turn optional confirmation into an unbounded research phase. Use current primary evidence for changing external contracts and released artifacts/tags for compatibility obligations.

## 4. Design below the gate

Write the design as free-form prose and tables below the gate, answering each template item that applies: current state, facts and owners, Actions and surfaces, states/values/resources, shape tests, design and decisions, execution units, QA and completion. Cite generic `AGENTS.md`, `DESIGN.md`, skills, large logs and bulky evidence by path with a concise digest instead of copying them. Every section must earn its place by preserving a decision, fact, invariant, dependency, or deciding check that a later zero-context implementer would otherwise have to rediscover.

Apply root **Scope-preserving solution economy** at design time: preserve the complete feature outcome, challenge unsupported machinery rather than the feature itself, and fold behavior into the canonical owner before proposing another path. When the work changes ownership, crosses packages, introduces persistence/concurrency, changes a public contract, or adds a ledger-class mechanism, write the intended caller-visible usage first and compare plausible designs from what callers should know. For a mechanism-sized decision, consider adding nothing, correcting or consolidating the canonical owner, the language/standard library, a platform-native capability that satisfies every affected surface, an existing package-owned dependency, and only then a new custom mechanism; choose the earliest option that satisfies the complete contract and minimizes total lifetime complexity, and never use this ordering to reduce required behavior, migration, removals, compatibility, UX, security, accessibility, platform support, testing, or validation. Be able to name why a materially simpler plausible alternative cannot satisfy the contract.

Where they apply, the design states: for cross-device or cross-runtime work, the client surfaces, canonical authority and executor, transport, durable state and lifetime, behavior while the authority is unavailable, and required consistency, without inferring any one from another; each designed surface's loading, empty, failed and offline states with their lab outcome and one whole-page fidelity acceptance owned by a named design lane (full lab page beside full live page, real data, light, dark and phone, differences classified per `happier-ui-craft` validation; component shots spread across units never add up to page fidelity; the lab is design intent, not a pixel contract); each user flow and design-lab scene mapped to the code owner that produces it; every user-facing capability as one Action that every surface reaches through the Action executor, with its Action id, read/write, placement, agent approval default from `safety`/`approvalPolicy.agentDefault`, person confirmation and reaching surfaces, with read Actions for anything an agent must choose from; where each new persisted value lives per root `AGENTS.md`; for each resource, its single loader, when it loads, what it fetches at real scale and what invalidates it (real change only); for each user-visible or persisted non-terminal state, its persisted fact, writer, reader and advancing or settling event, including stop, cancel, fail, retry, archive, revoke and reload (a state with no advancing event is a design defect); for a cross-Account or cross-Machine resource, who reads whose state, how access is withdrawn and the natural boundary where withdrawal takes effect (derived claims retire at that boundary through their owner, not through a re-check at every step); a feature reachable from several clients does not by itself move its authority to the server; the expected idle cost (zero apart from named liveness), checked against `.agents/skills/happier-performance` §1–2.

Classify every material choice as approved and binding, intentionally delegated to implementation discretion within named constraints, or deferred/excluded. Do not leave a choice implicitly open when different interpretations would change ownership, interfaces, compatibility, migration, security, UX, or acceptance. Call out a choice as difficult to reverse only when changing it later requires a concrete migration, destructive operation, compatibility break, external coordination, or public-contract transition, and record its undo path or approval consequence before implementation. Do not label large but ordinary refactors irreversible or add a gate merely to simulate reversibility. Record reasoning or rejected alternatives only when a later implementer or reviewer would otherwise have to rediscover them.

Choose the design that realizes the full intent with one canonical owner per decision; a consumed vertical from real entry point through owner to observable output; explicit invariants and fewer invalid states; reuse/refinement/removal of existing paths rather than a similar-but-different implementation; the narrowest compatibility transition justified by reachable released/predecessor combinations; and no dormant replacement spine, speculative extensibility, unnecessary gate, or test matrix manufactured by the plan itself. Do not optimize for the smallest diff when a coherent owner-level correction is broader. Do not solve unrelated corridor debt unless it is required to avoid a competing active owner or to make the authorized outcome correct. Report adjacent defects without manufacturing a transfer ledger; absorb another program's scope only with explicit user approval.

Execution units are ordered consumed verticals or independently verifiable gates with exact scope/ownership, dependencies, external/runtime preconditions not guaranteed by ordering, concrete outcomes, named required deletions, deciding checks, and traceability to the Flows rows they satisfy. The first unit delivers the ship journey thin, through real wiring end to end, and names the live recipe and loaded-runtime identity. Do not manufacture a precondition for ordinary code dependencies.

QA and completion: risk-weighted automated and live scenarios covering every materially affected flow, relevant edge/failure/recovery states, accessibility/performance/platform dimensions, and reachable compatibility directions without irrelevant Cartesian expansion, planned against the current moving source and existing development stack. Never introduce a frozen release representation, archive-production step, local package-installation gate, or publication proof as feature-completion evidence. Acceptance criteria are observable at the outermost practical contract surface; imports, registrations, types, file existence, and internal proxies are supporting evidence rather than completion when real behavior is runnable. Evidence that only release automation or human QA can produce goes into the gate's release-checks list with its prerequisite; it is not a completion gate. Do not write a per-requirement evidence matrix, a certification or activation section, an activation ledger, more than one ship journey (each flow's composed acceptance test is separate), or "measure later" gates — those make completion unreachable and produce circular finalization work.

Create new plans under the repository's existing `.project/plans/` convention, using a descriptive stable filename or the existing program folder; refine an existing plan in place unless the user requested a successor. Execution status, gate results and incident narration live in the program's existing tracking document (named in the plan header), never in the plan file; status-only updates do not change the contract revision. Use exact paths, symbols, contract shapes, and target filenames when established by evidence; when a detail is intentionally open, say what constraint governs the implementer's choice; do not invent false precision.

## 5. Plan lint

Before presenting a draft, run `node scripts/plans/lintPlan.mjs <plan.md>` once it lands; until then, apply its rules by hand. It fails when a gate heading is missing; when exactness, current-authority, freshness, re-check, re-prove, fail-closed, "immediately before" or "every read/launch/step" wording appears outside the mechanism ledger; when a ledger row lacks its owner or harm, or lacks both a reference and a Happier-specific requirement; or when execution status or gate results appear in the plan file. It never checks size.

## 6. Decompose for execution without losing global context

Use `.agents/skills/decompose-gates` to define meaningful lanes when parallel execution is actually possible. Each lane owns a complete responsibility and an independently deciding check; do not create microtasks, overlapping seam authorities, or horizontal layers that cannot be validated before later activation.

Every meaningful implementation, review, and QA lane reads the approved plan's gate, its own unit, and the sections that unit's "Also read" line names (the whole plan when it is small enough to read whole), unless they are already present in active context. Its lane brief then stays concise and self-contained: goal, ownership, exact paths/symbols, dependencies, acceptance checks, validation, expected output, permissions, and stop/fallback conditions. Reference the on-disk plan rather than pasting it or inheriting the full parent transcript; use minimal inherited conversation context.

### Programs of several plans

- State each cross-plan contract (shared names, error codes, approval rule, placement, performance rules) once in the program document; plans cite it and never restate it. Copies drift.
- A ruling names exactly one owner and one shape. Offer alternatives to the user as a question, never inside a ruling.
- The wave that applies a ruling edits every plan clause that consumes the changed contract in place, including plans in other programs, not only its owner, then runs a mechanical sweep for superseded terms before any reviewer starts.
- Every amendment or fix wave lists the mechanisms it adds and removes (its net mechanism delta), with where each runs and what carries its authority; the root deletion test applies to each.
- Batch the user's scope decisions before a review round where possible; a late scope addition reopens every dependent plan.
- Give every execution unit the same template and an "Also read" line naming the exact neighbouring sections it depends on, so a lane reads its own unit and those sections, not whole neighbouring plans.

## 7. Review the draft before approval


Before presenting a draft, attack it once at the plan-design phase:

- run the plan lint; for each fact, name the one owner that decides it and remove any other place the plan re-decides or re-checks it; confirm every ledger row passes **Choose good compromises**, revocation lands at the next natural boundary, and no numeric budget was invented;
- apply the root deletion test to each ledger row, including consequence, observability, recovery, and reversibility without it;
- re-derive whether it solves the real intent;
- look for missing consumers, dependencies, removals, failure/recovery behavior, and half-wired verticals;
- check split-brains, wrong-layer ownership, compatibility provenance, test value, and scope creep;
- ensure every required outcome has a deciding check and no task can be marked complete from code presence alone.

Select only the reasoning lens that addresses the plan's load-bearing uncertainty—such as hardest-constraint-first analysis, a pre-mortem, reversibility, or a fresh-executor ambiguity pass. Do not run every lens or create a separate report for each.

This is the plan's design review, not a mandatory second preflight during implementation. Resolve findings in the draft, surface remaining user decisions, and present the plan as `DRAFT`. Only explicit user approval establishes it as the `APPROVED` execution contract.

## 8. Preserve authority during execution

Once approved, the plan's required outcomes, ownership, interfaces, compatibility obligations, removals, user flows, exclusions, and acceptance criteria are authoritative. Implementation agents:

- read and execute the approved plan's gate and their units;
- may update only designated execution status and evidence;
- use best judgment only where the plan intentionally leaves implementation detail open;
- do not silently simplify, reinterpret, expand, substitute, or redesign approved requirements;
- rewrite in place, citing the ruling, a mechanism clause that contradicts a later owner ruling on mechanisms (OWNER-RULINGS Process); this is not an amendment;
- do not run a separate deep plan review before implementation; orient to current load-bearing anchors and begin.

Keep the approved contract stable and the execution ledger mutable. The orchestrator owns overall status, cross-lane dependencies, finding disposition, amendment records, and final verdict; lane agents update only their owned reports/status evidence. After compaction, interruption, reassignment, or an approved amendment, reread the plan's current contract/pivot and mutable execution state only when those contents are no longer active or may have changed.

Use these execution states:

- `PLANNED`
- `IN_PROGRESS`
- `IMPLEMENTED_NOT_VERIFIED`
- `VERIFIED_COMPLETE`
- `PARTIAL`
- `BLOCKED`
- `AMENDMENT_REQUIRED`
- `SUPERSEDED_BY_APPROVED_AMENDMENT`
- `NOT_APPLICABLE` with rationale

Never use `SUPERSEDED_BY_EVIDENCE`: evidence may challenge the plan but does not authorize changing it.

## 9. Amend rather than silently deviate

If primary evidence shows an approved requirement is unsafe, contradictory, impossible, based on a materially changed contract, unable to serve the approved intent, or requires a materially different topology, canonical owner, external dependency, compatibility transition, or product tradeoff than the approved plan disclosed, pause for amendment. Increased effort alone is not a material amendment.

1. pause the affected work;
2. record the exact evidence and affected requirements;
3. explain why ordinary implementation discretion cannot resolve it;
4. propose the smallest coherent amendment and its impact on dependencies, validation, and completed work;
5. ask the user to approve, reject, or redirect it;
6. resume only after approval, recording `SUPERSEDED_BY_APPROVED_AMENDMENT`.

Apply an approved amendment, and a ruling under §8, by editing the affected clauses in place so a lane never meets the superseded wording first; the header's approval and amendment record keeps one line per change (date, decision, pointer). Do not append amendment layers that leave the superseded clause readable.

Continue unaffected independent work only when it cannot prejudge the user's amendment decision. Material ambiguity follows the same stop-and-clarify path; unrelated discoveries are reported without expanding the plan.

When corrections accumulate until the document no longer reads as one coherent contract, propose a user-authorized `REPLACE` that regenerates it while explicitly preserving, changing, or retiring still-applicable material decisions rather than layering more amendments onto a contaminated document. Replace only a document that actually carries contradictions or stacked amendment layers; leave coherent ones to targeted edits. Before replacing, freeze the originals as the baseline. Only superseded wording, restatements of a contract now stated once elsewhere, and amendment narration may disappear: decisions and reasons, edge, failure and recovery behavior, limits, evidence pointers, execution units, tests and QA scenarios carry over. Each writer traces every old heading to its new home or removal reason, and an independent check compares old against new before approval. A shorter plan is a side effect, never the goal.

## 10. Define completion from evidence

No phase, lane, or plan is complete because files exist, code compiles, a checkbox changed, or an agent said “done.” `VERIFIED_COMPLETE` requires the implementation owner and reachable wiring, required removals/absence, meaningful RED → GREEN evidence for behavior changes, risk-appropriate broader validation, live QA for user-visible/environment-dependent behavior when the executor can run it, and explicit residual risk. Release-only evidence (devices, tenants, mail, signing, packaging) is recorded as a named release check and does not block `VERIFIED_COMPLETE`; a plan whose only open items are release checks is implementation-complete.

For plan-completeness review, use `.agents/skills/happier-review` and its `references/plan-completeness.md`. The reviewer grades implementation against the approved contract; it does not replace that contract.

When the user explicitly asks to execute or resume the approved plan, hand off to `.agents/skills/happier-implement-plan`; do not extend this authoring skill into a competing execution workflow.
