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

Plan authoring does not authorize implementation. If the user asked only for a plan, stop after presenting the draft. If the user requested both planning and implementation, present the plan for approval before treating it as the execution contract unless the user explicitly waived that checkpoint.

## 2. Recover the real intent before designing

State the outcome beneath the literal request:

- user-visible or operational problem;
- invariant or capability that must hold afterward;
- affected users/components and real workflows;
- explicit exclusions and non-goals;
- compatibility, security, performance, accessibility, platform, and rollout constraints that are actually reachable;
- evidence that will distinguish success from a plausible incomplete implementation.

Separate observed facts, derived conclusions, assumptions, and unresolved user decisions. Resolve decision-material ambiguity before finalizing a design; do not bury it as an implementation detail.

For cross-device or cross-runtime work, identify separately the client surfaces, canonical authority and executor, transport, durable state and lifetime, behavior while the authority is unavailable, and required consistency. Do not infer any one of these contracts from another.

Before decomposing work, derive the plan backward from the intended outcome:

1. state the user-visible, operational, compatibility, and architectural truths that must hold when the work is complete;
2. identify the canonical owners or artifacts that establish each truth;
3. identify the real entry points, consumers, wiring, migrations, removals, and compatibility paths required to make those owners authoritative;
4. identify the few links whose failure would be most damaging or least visible;
5. attach deciding evidence that observes each truth at the outermost practical contract surface.

Do not create a separate truth/artifact matrix when the plan's intent, target-state, execution, migration, QA, and completion sections can express this mapping.

Include a constraint only when it excludes or materially changes a plausible implementation. Convert vague qualities such as “robust,” “clean,” “premium,” or “scalable” into an observable contract, deciding principle, or acceptance signal; otherwise omit the decorative wording.

When a plan builds surfaces from a design lab, give each designed page one whole-page fidelity acceptance, owned by a named design lane: the full lab page beside the full live page, with real data, in light, dark and phone, and each difference classified per `happier-ui-craft` validation (defect, accepted refinement or lab outdated). Component shots spread across units never add up to page fidelity. The lab is the design intent, not a pixel contract.

Do not promote an architectural possibility, speculative future consumer, generalized reuse opportunity, another proposed mechanism, or unsupported robustness/scalability target into a requirement. Establish requirements from an approved outcome, constitution rule, external contract, reproduced failure, or reachable derived risk; mechanism selection and the recursive deletion test belong in the target-design step below.

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

## 4. Select the smallest coherent target design

Apply root **Scope-preserving solution economy** at design time: preserve the complete feature outcome, challenge unsupported machinery rather than the feature itself, and fold behavior into the canonical owner before proposing another path.

When the work changes ownership, crosses packages, introduces persistence/concurrency, changes a public contract, or adds a protocol, state machine, registry, table, lease, credential, generation, gate, or parallel path, write the intended caller-visible usage first and compare plausible designs from what callers should know. For each mechanism, trace its justification through proposed dependencies to an approved outcome, required invariant, released or external contract, reproduced failure, or reachable material risk. Apply the deletion test recursively: remove the mechanism and everything that exists only to support it, then name the required outcome that fails. Another proposed mechanism, future consumer, generalized reuse, or architectural completeness is not a terminal justification.

State the user need behind every geometric or behavioural constraint ("the viewer never covers content", "always fresh", "at most N"). Run the deletion test on the constraint at planning time: if the need is narrower than the constraint, plan for the need. Plan 63's "viewer must never cover content" produced five mechanisms that an owner amendment later deleted, because the real need was a viewer that floats over anything.

Treat every new limit, quota, timeout, retry budget, or guard as product behavior. Name the resource or contract it protects, derive it from that boundary rather than a nearby number, and define what happens when it fires; preserve useful valid data when safe rather than turning a safety backstop into an ordinary product filter.

For each resource a data-bearing feature reads, publishes or keeps alive, state four things: the single canonical loader; when it loads (open, visible, first real use); what it fetches at real scale; and what invalidates it (real change only). For each user-visible state and persisted non-terminal state (pending, claimed, custody, parked, waiting), also name its persisted fact, writer, reader, and the event that advances or settles it. Do the same for stop, cancel, fail, retry, archive, revoke and reload. For a cross-Account or cross-Machine resource, name who reads whose state, every withdrawal path, and what retires derived claims. For any "fresh / never show / always current" requirement, name its observation trigger and check it against the idle invariant. A state with no named advancing event is a design defect. Also state the expected idle cost, which should be zero apart from named liveness. Check the design against `.agents/skills/happier-performance` §1–2 before approval.

Apply scope-preserving solution economy only after fixing the complete target boundary. For a mechanism-sized decision, consider whether the outcome can be satisfied by adding nothing, correcting or consolidating the canonical owner, using the language/standard library, using a platform-native capability that satisfies every affected surface, using an existing package-owned dependency, or finally adding a new custom mechanism. Choose the earliest option that satisfies the complete contract and minimizes total lifetime complexity; never use this ordering to reduce required behavior, migration, removals, compatibility, UX, security, accessibility, platform support, testing, or validation.

Be able to name why a materially simpler plausible alternative cannot satisfy the contract. Record that reasoning only when it preserves a decision, constraint, or rejection that a later implementer or reviewer would otherwise have to rediscover; do not create a mandatory alternatives table or item-level justification ceremony.

Classify every material choice as approved and binding, intentionally delegated to implementation discretion within named constraints, or deferred/excluded. Do not leave a choice implicitly open when different interpretations would change ownership, interfaces, compatibility, migration, security, UX, or acceptance.

Call out a choice as difficult to reverse only when changing it later requires a concrete migration, destructive operation, compatibility break, external coordination, or public-contract transition. Record its undo path or approval consequence before implementation. Do not label large but ordinary refactors irreversible or add a gate merely to simulate reversibility.

Choose the design that realizes the full intent with:

- one canonical owner per decision;
- a consumed vertical from real entry point through owner to observable output;
- explicit invariants and fewer invalid states;
- reuse/refinement/removal of existing paths rather than a similar-but-different implementation;
- the narrowest compatibility transition justified by reachable released/predecessor combinations;
- no dormant replacement spine, speculative extensibility, unnecessary gate, or test matrix manufactured by the plan itself.

Do not optimize for the smallest diff when a coherent owner-level correction is broader. Do not solve unrelated corridor debt unless it is required to avoid a competing active owner or to make the authorized outcome correct. Report adjacent defects without manufacturing a transfer ledger; absorb another program's scope only with explicit user approval.

## 5. Write a self-contained execution contract

Plans may be large when the domain requires it. Do not impose arbitrary line, phase, or task-count limits; every section must earn its place by preserving a decision, fact, invariant, dependency, or deciding check that a later zero-context implementer would otherwise have to rediscover.

Create new plans under the repository's existing `.project/plans/` convention, using a descriptive stable filename or the existing program folder; refine an existing plan in place unless the user requested a successor. The plan must contain:

1. **Identity and state:** title, path, `DRAFT` status, contract revision, approval/amendment record, owner/user decision points, relevant plan relationships, and dated evidence basis where applicable. Status-only execution updates do not change the contract revision.
2. **Intent:** problem, target outcome, users/flows (each user flow and design-lab scene mapped to the code owner that produces it), non-goals and plan-specific forbidden mechanisms, material outcome truths, outermost success evidence, and stable IDs for material requirements and invariants in substantive plans.
3. **Current-state evidence:** canonical owner, affected corridor, existing split-brains, contracts, compatibility provenance, and relevant tests/harnesses with exact paths/symbols.
4. **Target state:** an Action-parity table for user-facing capabilities (capability → Action id → read/write → placement → agent approval default from `safety`/`approvalPolicy.agentDefault` → person confirmation), with read Actions for anything an agent must choose from; where each new persisted value lives (owning record, Session metadata, server-visible non-content metadata, device-local store, or a deliberate setting, per root `AGENTS.md`); a `happier-performance` count contract for each new producer, timer or poll; final ownership, data/control flow, interfaces, invariants, file/module placement, migrations/removals, and retained compatibility seams with removal conditions.
5. **Decisions:** selected design; choices that are approved, intentionally delegated within constraints, or deferred/excluded; concrete one-way decisions and undo consequences; unresolved material user decisions; rejected alternatives when useful; and why the selected design removes more total complexity or risk. Reference decision evidence by path instead of creating item-level ratification bureaucracy.
6. **Execution units:** ordered consumed verticals or independently verifiable gates, exact scope/ownership, dependencies, external/runtime preconditions not guaranteed by ordering, concrete implementation outcomes, named required deletions, deciding checks, and traceability to the material requirement/invariant IDs they satisfy. The first execution unit delivers the program's composed journey thin, through real wiring end to end. Later units widen it. Name the live recipe and the loaded-runtime identity in that first unit. Do not manufacture a precondition for ordinary code dependencies.
7. **QA and validation:** risk-weighted automated and live scenarios covering every materially affected flow, relevant edge/failure/recovery states, accessibility/performance/platform dimensions, and reachable compatibility directions without irrelevant Cartesian expansion. Plan feature QA against the current moving source and existing development stack; never introduce a frozen release representation, archive-production step, local package-installation gate, or publication proof as feature-completion evidence.
8. **Completion contract:** observable acceptance criteria at the outermost practical contract surface, negative requirements, the deciding check for each execution unit, what explicitly prevents completion, and one composed end-to-end journey as the program's ship recipe. Imports, registrations, types, file existence, and internal proxies are supporting evidence rather than completion when real behavior is runnable. Evidence that only release automation or human QA can produce (physical devices, real third-party tenants, mail delivery, signing, packaging, production-like infrastructure) goes into one short "Release checks" list with its prerequisite; it is not a completion gate. Do not write a per-requirement evidence matrix, a certification or activation section, an activation ledger, more than one composed journey, or "measure later" gates — those make completion unreachable and produce circular finalization work.
9. **Execution tracking:** mutable status/evidence area separate from the approved design contract.

Use exact paths, symbols, contract shapes, and target filenames when established by evidence. When a detail is intentionally open, say what constraint governs the implementer's choice; do not invent false precision. Reference generic `AGENTS.md`, `DESIGN.md`, skills, large logs, and bulky evidence by path with a concise digest instead of copying them into the plan.

## 6. Decompose for execution without losing global context

Use `.agents/skills/decompose-gates` to define meaningful lanes when parallel execution is actually possible. Each lane owns a complete responsibility and an independently deciding check; do not create microtasks, overlapping seam authorities, or horizontal layers that cannot be validated before later activation.

Every meaningful implementation, review, and QA lane must read the complete approved plan unless it is already present in active context. Its lane brief then stays concise and self-contained: goal, ownership, exact paths/symbols, dependencies, acceptance checks, validation, expected output, permissions, and stop/fallback conditions. Reference the on-disk plan rather than pasting it or inheriting the full parent transcript; use minimal inherited conversation context.

### Programs of several plans

- State each cross-plan contract (shared names, error codes, approval rule, placement, performance rules) once in the program document; plans cite it and never restate it. Copies drift.
- A ruling names exactly one owner and one shape. Offer alternatives to the user as a question, never inside a ruling.
- The wave that applies a ruling updates every plan that consumes the changed contract, including plans in other programs, not only its owner, then runs a mechanical sweep for superseded terms before any reviewer starts.
- Every amendment or fix wave lists the mechanisms it adds, with where each runs and what carries its authority; the target-design deletion test applies to each.
- Batch the user's scope decisions before a review round where possible; a late scope addition reopens every dependent plan.
- Give every execution unit the same template and an "Also read" line naming the exact neighbouring sections it depends on, so a lane reads its own plan and those sections, not whole neighbouring plans.

## 7. Review the draft before approval

Before presenting a draft, attack it once at the plan-design phase:

- re-derive whether it solves the real intent;
- look for missing consumers, dependencies, removals, failure/recovery behavior, and half-wired verticals;
- apply the target-design step's recursive deletion test to each proposed mechanism, including consequence, observability, recovery, and reversibility without it;
- check split-brains, wrong-layer ownership, compatibility provenance, test value, and scope creep;
- ensure every required outcome has a deciding check and no task can be marked complete from code presence alone.

Select only the reasoning lens that addresses the plan's load-bearing uncertainty—such as hardest-constraint-first analysis, a pre-mortem, reversibility, or a fresh-executor ambiguity pass. Do not run every lens or create a separate report for each.

This is the plan's design review, not a mandatory second preflight during implementation. Resolve findings in the draft, surface remaining user decisions, and present the plan as `DRAFT`. Only explicit user approval establishes it as the `APPROVED` execution contract.

## 8. Preserve authority during execution

Once approved, the plan's required outcomes, ownership, interfaces, compatibility obligations, removals, user flows, exclusions, and acceptance criteria are authoritative. Implementation agents:

- read and execute the complete approved plan;
- may update only designated execution status and evidence;
- use best judgment only where the plan intentionally leaves implementation detail open;
- do not silently simplify, reinterpret, expand, substitute, or redesign approved requirements;
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
6. resume only after approval, recording `SUPERSEDED_BY_APPROVED_AMENDMENT` and preserving the amendment history.

Continue unaffected independent work only when it cannot prejudge the user's amendment decision. Material ambiguity follows the same stop-and-clarify path; unrelated discoveries are reported without expanding the plan.

When corrections accumulate until the document no longer reads as one coherent contract, propose a user-authorized `REPLACE` that regenerates it while explicitly preserving, changing, or retiring still-applicable material decisions rather than layering more amendments onto a contaminated document. Replace only a document that actually carries contradictions or stacked amendment layers; leave coherent ones to targeted edits. Before replacing, freeze the originals as the baseline. Only superseded wording, restatements of a contract now stated once elsewhere, and amendment narration may disappear: decisions and reasons, edge, failure and recovery behavior, limits, evidence pointers, execution units, tests and QA scenarios carry over. Each writer traces every old heading to its new home or removal reason, and an independent check compares old against new before approval. A shorter plan is a side effect, never the goal.

## 10. Define completion from evidence

No phase, lane, or plan is complete because files exist, code compiles, a checkbox changed, or an agent said “done.” `VERIFIED_COMPLETE` requires the implementation owner and reachable wiring, required removals/absence, meaningful RED → GREEN evidence for behavior changes, risk-appropriate broader validation, live QA for user-visible/environment-dependent behavior when the executor can run it, and explicit residual risk. Release-only evidence (devices, tenants, mail, signing, packaging) is recorded as a named release check and does not block `VERIFIED_COMPLETE`; a plan whose only open items are release checks is implementation-complete.

For plan-completeness review, use `.agents/skills/happier-review` and its `references/plan-completeness.md`. The reviewer grades implementation against the approved contract; it does not replace that contract.

When the user explicitly asks to execute or resume the approved plan, hand off to `.agents/skills/happier-implement-plan`; do not extend this authoring skill into a competing execution workflow.
