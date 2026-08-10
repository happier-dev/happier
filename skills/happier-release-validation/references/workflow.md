# Release Validation Workflow

## Operating Model

The main agent is the orchestrator: team lead, auditor, planner, and integrator. It should delegate long-running lanes and fixes to subagents, keep the live tracking documents current, and maintain enough parallelism to avoid idle time.

The orchestrator should not act as a passive reporter. If a lane finds a real issue, the lane or a narrow fix agent should implement the root-cause fix directly, using TDD when executable behavior changes.

The generated lane list is a starting map, not a ceiling. Add lanes when drift analysis, prior-audit harvest, QA, or reviewer findings expose a new release-risk surface.

Delegate lane-sized work, not tiny errands. A good lane agent owns the check/QA surface end-to-end: execute, collect evidence, diagnose failures, implement in-scope root-cause fixes if write ownership is granted, rerun targeted checks, update lane docs, and report residual risks. Split only when resource collisions, write-scope collisions, or root-cause ownership require it.

## Source Of Truth Loop

At startup, after compaction, after a long wait, and before declaring any phase complete:

1. Read `TRACKING.md` for mission, non-negotiables, open questions, risk matrix, QA matrix, and exit criteria.
2. Read `PLAN.md` for the current phase and first incomplete marker.
3. Read the latest `LEDGER.md` entries for what actually happened and where evidence lives.
4. Continue from the first `[~]`, `FAILED`, or `[BLOCKED]` item.

Keep `PLAN.md` concise. Put execution detail and logs in `LEDGER.md` or evidence files.

`PLAN.md` is the marker board: phase status, lane status, active agent queue, and active resource ownership. Do not turn it into a verbose execution report. `LEDGER.md` is the execution trail. `TRACKING.md` is the release-risk and decision source of truth.

## Process Feedback Rule

If an agent is confused by the skill, a lane prompt, missing command, unclear evidence requirement, bad template structure, or missing process guidance, record it in `TRACKING.md#Process Feedback`.

Do not stop validation for process feedback unless it blocks trustworthy evidence. Continue with the best safe interpretation, mark the feedback item `open`, and keep the release-risk findings separate.

At the end of validation, ensure the handoff packet points the review skill at `Process Feedback` so the templates can be improved after the run.

## Throughput And Delegation Loop

The orchestrator should keep useful agents in flight until no independent work remains.

1. Re-anchor on `TRACKING.md`, `PLAN.md`, and `LEDGER.md`.
2. Identify ready lanes, blocked lanes, active agents, and resource/write-scope collisions.
3. Dispatch the largest safe independent lane chunks, not tiny tasks.
4. While agents run, do non-overlapping orchestration work: update docs, classify completed failures, prepare reviewer/fix prompts, or run local commands that do not collide.
5. When an agent completes, update `PLAN.md` markers and `LEDGER.md`, then immediately dispatch the next ready non-colliding lane if one exists.
6. Do not interrupt long-running agents unless their scope is wrong, they are mutating forbidden resources, or they are stuck past the stall threshold.

Use the `Active Agent Queue` in `PLAN.md` to avoid losing track of who owns what. Keep entries short: lane, role, owner/model, status, resource/write scope, and next expected evidence.

## Phase Model

### Phase 0: Bootstrap

Create the worktree, branch, and ignored `.project/reviews/...` workspace. Confirm package versions, branch base, preview base, and release-validation scope. Harvest still-relevant scenarios from `.project/reviews/2026-04-15-preview-release-readiness-orchestrated-audit/` when present. Do not run lanes before the workspace exists.

If `TRACKING.md` renders any baseline field as `unavailable`, stop Phase 0 execution. Repair the missing local metadata, usually with `git fetch origin preview`, then rerun the bootstrap script with `--resume` so the live tracking docs receive trustworthy baseline data before Phase 1 starts.

### Phase 1: Discovery And Environment Prep

Run in parallel:
- diff/risk audit from `origin/preview..HEAD`
- pre-mortem
- environment prep for Lima, macOS, Windows, Docker, ports, and browser auth state
- early baseline checks when safe

### Phase 2: Automated Local Checks

Run automated checks and release-validation lanes locally whenever possible. The original custom check set is still required, but it is not the whole release validation.

Start Phase 2 with an initial failure-collection sweep. Dispatch independent lanes/checks in parallel by resource group, collect failures, and update `TRACKING.md`/lane docs before implementing fixes. Do not default to "run one suite, fix it, then run the next suite" because that serializes discovery and hides shared root causes.

Good parallel candidates include unit tests, typecheck, release contracts, docs/website builds, provider smoke split per provider, and read-only audits. Resource-constrained lanes must be scheduled deliberately: Docker-heavy lanes, same Lima VM lanes, UI/core E2E lanes that collide on ports, and OS service mutation lanes on macOS/Windows.

### Phase 3: Continuity And Installer Validation

Validate the concrete upgrade and continuity paths affected by the candidate. Cover CLI update, daemon continuity, session continuity, Linux/macOS/Windows installer smoke, binary smoke where supported, and artifact verification where supported. When relay code, configuration, persistence, or migrations changed, define an exact released-relay-to-candidate scenario with its source version, database/provider, state, and expected invariants; do not treat a generic `server-upgrade` label as evidence.

### Phase 4: Manual Cross-OS QA

Run deep QA on Linux Lima VMs, macOS host, and Windows through `~/connect_windows.sh`. Reuse the same account, browser auth state, hostname, port, and relay URL for flows that must prove account/session continuity.

### Phase 5: Fix/Review Iteration

When failures appear:
- collect failures from lanes
- group by root-cause surface
- dispatch focused fix agents and coordinate only actual overlapping hunks, incompatible seam decisions, generated outputs, or exclusive mutable resources
- require targeted RED/GREEN evidence for behavior changes
- rerun impacted lane
- rerun the harness invariant after each fix cluster: the immediately affected lane plus `node scripts/pipeline/run.mjs checks --profile fast`
- when code files changed, run `graphify update .` after the fix cluster so future graph-assisted analysis sees current code
- dispatch independent reviewers for completed critical lanes while other work continues

Only fix immediately during the initial sweep when the failure blocks most remaining evidence collection or makes later results untrustworthy. Otherwise, finish enough parallel discovery to classify shared failures first.

### Phase 6: Final Validation Only

Run final integrated checks and local release dry-run. Stop with a validation handoff. Do not release.

## Human Gates

Human review happens between skills, not between every local step.

Validation skill stops before release. The next skill should review the validation branch and evidence. A separate promotion skill may release only after explicit human approval.

## Waiting On Sub-Agents And Long Commands

- Let long-running agents and commands run to completion. Do not report early just because the first wait interval expired.
- When the tool supports background execution and completion notifications, rely on those notifications instead of sleep/poll loops.
- Use command/session monitoring only when streamed output is needed to diagnose a live failure.
- Never run `sleep N && check` loops; they waste time and can be blocked by the harness.
- If a lane is `[~]` for more than 2 hours with no new `LEDGER.md` entry, classify it as stalled: request status from the lane owner, then reassign or mark `[BLOCKED]` with the missing evidence.

If only some agents complete, do not wait for the whole batch before making progress. Process completed results, update markers, dispatch follow-on work when safe, then continue waiting for the remaining agents.

## Model Routing Policy

Treat model routing as cost/speed guidance, not as a hard dependency. If a requested model is unavailable, use the strongest available equivalent and record the substitution in `LEDGER.md`.

- Orchestrator: `gpt-5.3-codex` or fast Codex model.
  Good fit because orchestration is mostly planning, tracking, delegation, evidence synthesis, and command coordination.
- Read-only auditors and check runners: `gpt-5.3-codex` or cheaper/fast model.
  They mainly run commands, classify failures, update lane docs, and collect evidence.
- QA agents, default: `gpt-5.3-codex`.
  Good fit for scripted/manual QA because the work is long-running, tool-heavy, evidence-heavy, and benefits more from persistence than maximum reasoning.
- QA agents, high-risk exploratory: `gpt-5.5` high.
  Use for daemon ownership, installer rollback, account/session continuity, cross-OS divergence, or when QA must infer likely user breakage from ambiguous behavior.
- Fix agents, default: `gpt-5.5` high.
  Especially for root-cause fixes, cross-package bugs, daemon ownership, installers, session continuity, provider architecture, release pipeline, or anything touching tests plus runtime code.
- Fix agents, simple/narrow: `gpt-5.3-codex` acceptable.
  Example: stale fixture update, one isolated test expectation cleanup, docs-only fix, obvious command typo, or one-file low-risk implementation.
- Independent final reviewers: `gpt-5.5` high.
  Fresh context, skeptical review, cross-cutting risk analysis.
- Emergency escalation: `gpt-5.5` xhigh.
  Use for broad protocol/schema changes, migration risks, daemon/service ownership ambiguity, installer rollback logic, or when two agents disagree.

Do not spend strongest models on mechanical reruns, log collection, or docs-only work unless the lane is blocked by ambiguity.

## Fix Delegation Policy

Cluster by root-cause surface, not package. Multiple fix agents may work in the same package if their write sets are disjoint.

Each fix prompt must include:
- exact suspected root cause or failure cluster
- exact allowed write paths
- paths that must not be edited
- relevant tests to inventory before adding tests
- targeted command for RED/GREEN iteration
- broader command required before handoff

If two failures share a likely root cause, do not split them until the shared owner is clear.

For fix clusters, prefer medium-sized ownership: broad enough for one agent to understand and fix the root cause fully, narrow enough to avoid write conflicts. Examples: `apps/ui new-session provider picker`, `apps/cli daemon service takeover`, `packages/tests UI shared testkit`, `scripts/pipeline local-build installer assets`.

Use Conventional Commit wording for any commit the human later asks to create: `<type>(<scope>): <subject>`. For TDD fix clusters, keep the lane id in the body, for example `Fixes L21-DO-08`. Do not commit during validation unless the user asks.

Stop and ask before accepting a fix that changes release or agent harness behavior, including `.claude/hooks/`, `.claude/agents/`, `scripts/pipeline/run.mjs`, or `scripts/pipeline/checks/**`.

## Release Validation Test-Fix Policy

Apply the repo testing rules from `AGENTS.md`, with these release-validation-specific guardrails:

- Before changing tests, inventory existing coverage and the owning testkit/helper for the failing boundary.
- Do not patch stale local mocks file-by-file when a mocked target changed shape. Prefer fixing the package-owned shared testkit, fixture builder, or boundary mock factory once.
- Prefer real internal behavior over internal mocks. Boundary mocks are allowed only for system/external/platform boundaries, and they must mirror the real response shape.
- Local inline mock changes are allowed only when genuinely one-off, minimal, and recorded in the lane evidence with the reason a shared helper was not appropriate.
- Do not delete useful tests to make a lane pass. Delete or loosen only brittle assertions that pin wording/copy/incidental formatting rather than behavior.
- Behavior fixes require RED/GREEN evidence. Test-only fixture updates require a targeted rerun and a note explaining whether the test or production code was stale.
- If a fix touches a shared testkit/mock/harness, rerun one broader related lane before declaring the cluster complete.
- If the same missing mock method or fixture field appears in multiple files, stop local patching and assign a narrow fix agent to the shared test infrastructure.

## Lightweight Resource Ownership

Do not build a lock service. Use the `Active Resource Ownership` table in `PLAN.md`.

Track only resources that can create real collisions:
- write paths or modules
- Lima VM names
- macOS launchd/service state
- Windows SSH host
- Docker daemon when a lane mutates Docker state
- host port ranges
- release artifact directories
- browser auth storage state when a lane writes auth state

Concurrent read-only access is fine. Concurrent mutation of the same resource is not.

## Reviewer Policy

Reviewers should be fresh-context where possible. They read only:
- `TRACKING.md`, `PLAN.md`, `LEDGER.md`
- lane document
- evidence paths
- relevant diffs

Reviewer verdicts: `GREEN`, `RED`, or `NEEDS-MORE-EVIDENCE`.

Dispatch reviewers while other lanes continue when a critical lane or fix cluster reaches `[VERIFYING]`. Use independent reviewers for daemon ownership, installer/update, session continuity, shared test infrastructure fixes, and final cross-cutting readiness. A lane owner's self-review is useful but does not replace an independent reviewer for critical release-risk surfaces.
