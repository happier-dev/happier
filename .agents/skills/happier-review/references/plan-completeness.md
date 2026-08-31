# Plan Completeness Review

An approved plan is the execution contract for its required outcomes, ownership, interfaces, compatibility obligations, removals, user flows, exclusions, and acceptance criteria. It is not proof of completion: never mark a plan complete because code exists, a checkbox is checked, a test is named, or an agent reports completion.

## Select the review phase

Do not merge distinct plan activities:

- **Pre-approval plan review:** when the user asks to review or refine a draft plan, challenge its assumptions, mechanisms, dependencies, scope, completeness, and acceptance evidence before approval.
- **Implementation-completeness review:** when judging work against an approved plan, grade the implementation against that contract. Do not reopen the design merely because a reviewer prefers another implementation.
- **Amendment review:** when new primary evidence materially contradicts an approved requirement, verify the evidence and proposed smallest amendment. The reviewer may recommend an amendment but cannot authorize it; affected implementation remains paused until user approval.

## Review a draft plan before approval

Apply root **Scope-preserving solution economy** when reviewing a draft: preserve the complete intended feature outcome, challenge unsupported proposed machinery rather than the feature itself, and reject a split-brain or parallel path when the canonical owner can satisfy the need.

Only in pre-approval plan review, re-derive the user-visible problem and desired invariant independently of the draft's chosen mechanism. For every proposed protocol, state machine, table, registry, lease, credential, generation, feature gate, or parallel path, require:

- the complete justification chain through dependent mechanisms to an approved outcome, required invariant, released or external contract, reproduced failure, or reachable material risk—not another proposed mechanism, future consumer, generalized reuse, or architectural completeness;
- the reachable consequence without the mechanism, authority and state affected, observability, existing recovery, and reversibility;
- when the plan introduces shared persistence, replicated projections, placement, failover, or cross-machine coordination, the named current consumer, state authority and lifetime, and evidence that a request-through-authority or replaceable-cache design cannot satisfy the approved contract;
- why the current canonical owner cannot enforce the contract more directly;
- the producer, entry point, activation step, and composed live recipe;
- the recursive deletion result and the old, parallel, or dependent paths that must contract;
- for each new limit, quota, timeout, retry budget, or guard, the actual resource or contract basis and what happens when it fires;
- any released/persistence compatibility direction that genuinely requires staged coexistence.

Treat a refactor-behind-a-gate as a split-brain candidate under `docs/feature-gating.md`, not as automatic rollout safety. Resolve material design flaws before approval rather than delegating architecture adjudication to implementation agents.

For overlapping programs, identify one active authority per conceptual seam. The plan should name `Supersedes:`, `Extends:`, and `Consumes:` relationships where relevant. Plans may stay self-contained about product decisions and acceptance criteria, but should reference current repository doctrine rather than copy it into plan-specific operating manuals that can drift.

## Build the material-outcome ledger

Read the complete plan and every decision-relevant referenced document before verdicts. Decompose it into material observable outcomes and independently failing invariants, including:

- required behaviors and user flows;
- architectural ownership and invariants;
- data, migration, compatibility, rollout, and removal requirements;
- failure, recovery, permission, and lifecycle behavior;
- tests, QA, performance, accessibility, and operational acceptance criteria;
- explicit exclusions and forbidden approaches.

Do not create separate claims for repeated wording, implementation subtasks, historical markers, task counts, or evidence dimensions already governed by the same deciding gate. The ledger must preserve every material obligation without becoming a second execution plan.

Record each claim as one of:

- `VERIFIED_COMPLETE`
- `IMPLEMENTED_NOT_VERIFIED`
- `PARTIAL`
- `MISSING`
- `CONTRADICTED`
- `BLOCKED`
- `AMENDMENT_REQUIRED`
- `SUPERSEDED_BY_APPROVED_AMENDMENT`
- `OUT_OF_SCOPE` or `NOT_APPLICABLE` with rationale

## Evidence required for completion

For each `VERIFIED_COMPLETE` claim, record:

- exact implementation owner and paths;
- entry point/caller proving the implementation is wired and reachable;
- affected readers, writers, consumers, and outputs;
- meaningful contract/test evidence;
- runtime or manual QA evidence when the claim is user-visible or environment-dependent;
- compatibility provenance/directions when version skew or persisted state is involved;
- absence/migration evidence for paths the plan required to remove;
- remaining uncertainty, if any.

Acceptance evidence should observe the outermost surface named by the requirement—user flow, CLI result, API/wire contract, persisted state, process lifecycle, provider behavior, or published artifact. Internal imports, registrations, schemas, mocks, and helper tests support that verdict but cannot replace the real surface when it is runnable.

For long-running or cross-repository programs, keep completion dimensions separate: `implemented`, `automated`, `live`, `ported-to-dev`, and `independently-reviewed`, using `NOT_APPLICABLE` where a dimension truly does not apply. Do not collapse these into a prose “done” status or require every dimension for routine local work.

Code presence alone is insufficient. Specifically reject as sole proof:

- an unused interface, helper, flag, route, or UI control;
- a test that only verifies a mock or current implementation reconstruction;
- a passing typecheck/build;
- an agent/lane “done” report;
- a feature-gated path whose real gate and configuration were not checked;
- one component implemented without its required peer wiring;
- a new canonical path while legacy callers or competing owners remain active.

When implementation and wiring are present but the material behavior surface did not run, use `IMPLEMENTED_NOT_VERIFIED`. When the expected result itself cannot be derived from the approved contract or a current external contract, do not invent it: record the decision-material ambiguity as `AMENDMENT_REQUIRED` or a clearly named blocker, depending on whether the contract must change.

## Verify end to end

Trace each claim through its real path. Check secondary behavior and negative requirements, not only the primary implementation: error/recovery states, permissions, persistence/reload, concurrency when relevant, rollout directions, removal of obsolete paths, and actual user-visible output.

For removals or migrations, search for remaining imports, symbols, routes, config keys, storage keys, feature ids, provider ids, fixtures, docs, and direct callers. “Not found” is evidence only when the searched basis and patterns are recorded.

## Handle contradictions and amendments

Do not silently accept implementation drift. When implementation differs from the approved plan:

- an undocumented or unjustified deviation is a finding even if it looks plausible;
- extra implementation without an approved plan/goal basis is scope drift unless it is necessary to realize an approved owner-level requirement;
- a material contradiction supported by primary evidence becomes `AMENDMENT_REQUIRED`, not permission for the agent to redesign the work;
- `SUPERSEDED_BY_APPROVED_AMENDMENT` requires the invalidating evidence, the documented replacement decision, and explicit user approval.

## Completeness verdict

The plan is fully implemented only when every required claim is `VERIFIED_COMPLETE`, `SUPERSEDED_BY_APPROVED_AMENDMENT`, or defensibly `NOT_APPLICABLE`, and all load-bearing claims have appropriate evidence. `IMPLEMENTED_NOT_VERIFIED`, `PARTIAL`, `MISSING`, `CONTRADICTED`, `AMENDMENT_REQUIRED`, or decision-material `BLOCKED` prevents a complete verdict.
