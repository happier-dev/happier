# Review Orchestration

Use orchestration to deepen independent work, not to perform parallelism theater. The orchestrator owns scope, lane design, the main tracking document, finding verification, consolidation, and final judgment.

## Workspace and source of truth

For substantial work, create one unique `.project/reviews/...` workspace. The orchestrator alone updates `TRACKING.md`; lane agents write only their assigned `subagents/<lane>.md`, and raw evidence goes under `evidence/`. Update tracking only when scope, readiness, blockers, authority, finding disposition, substantial review-boundary state, or the verdict changes. Ordinary searches, lane dispatches, self-checks, RED/GREEN loops, fixes, and local validations stay in command output and concise lane handoffs.

Never read or merge sibling review workspaces unless the user explicitly placed them in scope. They may belong to concurrent agents.

## Lane design

Map the target and affected corridor before dispatch. Skip a separate cartography wave when the orchestrator can already identify coherent lanes. Use cartography only for a genuinely ambiguous or very broad surface where its output changes decomposition.

Create lanes by independently checkable feature, canonical owner, runtime flow, risk seam, or cross-cutting concern. Do not delegate tiny searches, mechanical inventories, or lanes whose conclusions depend on each other. Cross-cutting security/data/lifecycle/architecture/test/UX lanes are activated by risk and must have distinct questions rather than reread everything generically.

Use maximum useful concurrency; set no artificial fleet cap or required minimum. Keep ready independent lanes moving when they shorten the critical path. File dirtiness or prior edits are not collisions: coordinate only overlapping hunks, incompatible decisions for one conceptual seam, generated outputs with one producer, or exclusive mutable resources.

## Context-efficient delegation

For Codex subagents, use `fork_turns="none"` by default for inventory, review, log analysis, tests, and QA. Use inherited conversation history only when the lane truly depends on decisions that cannot be captured in its brief.

A lane brief must be detailed and self-contained about the task while referencing shared doctrine by path rather than pasting it. Include:

- target, intent basis, exact revision/worktree basis, and current dirty-state warning;
- exact paths/symbols/flows and canonical-owner hypothesis;
- observed evidence and named risk question;
- in-scope and explicit out-of-scope surfaces;
- required adjacent callers/readers/writers/tests/compatibility paths;
- falsifiable success/review claim and deciding checks;
- output mode, write authorization and prohibitions (not exclusive file ownership), and shared seam/resource coordination;
- lane report/evidence paths;
- required skill/reference paths;
- stop/fallback conditions and reviewer trigger.

Tell every worker it is not alone in the codebase and must preserve unrelated concurrent work. A dirty file is normal shared state, not an ownership claim: inspect current bytes and layer compatible changes. Escalate only an actual same-hunk collision, an incompatible decision for one live seam, or an exclusive resource conflict that cannot be safely sequenced.

Do not paste full plans, diffs, logs, or all review modules into every brief. Pass exact relevant excerpts or paths plus a digest. Save raw command output to evidence and return compact summaries/failure excerpts; inspect raw evidence when ambiguity or exact verification requires it.

Prefer inventories, grouped results, counts, and decisive excerpts over transcript dumps. Use `rtk` when available and semantically appropriate under the root policy; retain or rerun raw evidence for failures, security/data/schema work, ambiguity, and exact final verification. Do not add extra model/tool turns merely to save trivial output.

Do not hardcode model versions in review artifacts. Use the strongest appropriate reasoning for orchestration, architecture/root-cause synthesis, and independent high-risk verdicts; use efficient models/effort for inventories, bounded searches, deterministic checks, log collection, and mechanical QA. A lower-cost lane still receives the same evidence and acceptance contract.

## Reviewer and fixer roles

- Read-only lane reviewers investigate and report; they never fix unless the selected mode and brief explicitly grant an in-scope fix responsibility that can be coordinated safely with current work.
- In `fix` mode, a routine lane may diagnose, fix, and rerun its own scenario. The orchestrator checks enough current source, diffs, and deciding evidence to integrate it; formal independent verification waits for the applicable substantial boundary unless a high-risk trigger cannot safely wait.
- High-risk user-visible, security, schema/data, compatibility, and release ship gates require a reviewer different from the author when available.
- A boundary or ship reviewer receives the concise observed basis, relevant diff/paths, material claims, and evidence paths—not the author's full persuasive narrative. Its task is to refute.

Re-derive every accepted finding from primary evidence. Use `.agents/skills/verify-claims` for decision-material delegated claims consolidated at the applicable boundary; do not create a formal claim audit for every routine lane output or count reviewer agreement as evidence.

## Review availability and cadence

- Advisory review may inspect moving, dirty, partial, or completed work at any time and report evidence-backed findings without a completeness verdict.
- Formal independent review is normally batched at the fewest substantial integrated boundaries needed by the approved plan, plus explicit user-requested reviews and decision-material security/data/persistence/compatibility triggers that cannot safely wait. Do not invent per-lane, per-gate, per-commit, or per-microchange independent review gates.
- Record a concise observed basis: plan revision when applicable, current HEAD and dirty-state acknowledgement, relevant paths/symbols/flows, checks run, and observed loaded source/build identity where relevant. Do not freeze or hash worktrees, create release-representation manifests, leases, receipts, custody records, or global invalidation machinery.
- Concurrent changes do not invalidate an entire review. Before relying on a finding or issuing a boundary/ship verdict, reconcile only materially affected observations that changed; retain unaffected evidence.
- After accepted fixes, review the finding delta plus affected corridor. Start another full round only for a materially changed approved contract, architecture, scope, review boundary, or risk.
- Repeated same-class findings or rounds that only harden hazards created by a dormant mechanism trigger a design/deletion decision. They do not justify an unlimited review loop.

## Dynamic expansion and stopping

Add a lane when evidence reveals a decision-material uncovered owner, consumer, failure mode, or scenario. Do not spawn another agent merely because confidence feels uncomfortable or to obtain nicer wording. First state the question and the observation that would falsify it.

Stop when the explicit basis is inventoried, the affected corridor and named risk spots have deciding evidence, findings are triaged, QA obligations are accounted for, and residual gaps are labeled. Continue when a material surface is unreviewed; stop collecting optional confirmation after the evidence bar is met.
