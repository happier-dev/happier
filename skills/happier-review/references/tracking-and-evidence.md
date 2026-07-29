# Tracking And Evidence

## Tracking tiers

- **Direct review:** no workspace unless requested; report directly when the work is bounded and evidence fits safely in the handoff.
- **Durable review:** use one isolated `.project/reviews/<unique-id>/` workspace when the review is long-lived, multi-lane, plan-wide, substantively QA-heavy, or has bulky evidence that must survive context loss. Output mode alone does not require a workspace.
- **Release validation:** use the release-validation workspace and skill, not a competing generic workspace.

Bootstrap deep reviews with `scripts/bootstrap-review.mjs`. Pass repeatable `--path` arguments for feature, session, corridor, or plan reviews; use `--full-worktree` only when the explicit target is the whole dirty worktree. The script records global dirty state as a boolean and captures detailed status plus staged/unstaged diffs only for the selected paths or explicit whole-worktree target. It never hashes or freezes review inputs.

## Workspace ownership

The orchestrator owns exactly its generated workspace. Never read or write a sibling review workspace unless the user explicitly identifies it as an input. Subagents write only their assigned files under `subagents/` and `evidence/`; the orchestrator alone updates `TRACKING.md` and the final report.

Never store credentials, access keys, tokens, raw secrets, or unnecessarily sensitive personal data in reports, prompts, screenshots, or evidence. Record only a redacted identity or runtime-supplied credential source.

## Living state without transcript theater

Update tracking only on readiness-changing transitions:

- review basis or scope established/changed;
- risk or QA ledger changed;
- substantial boundary ready/closed/blocked or a dependency becoming available;
- issue accepted/rejected/escalated;
- approved authority/contract or fix-cluster readiness changed;
- validation result changed;
- final decision or residual risk changed.

Do not write every thought or append stale logs. Ordinary lane dispatches, RED/GREEN loops, fixes, self-checks, and local validations stay in command output and concise lane handoffs. Rewrite the current best state; keep necessary bulky output in evidence files.

## Evidence contract

Good evidence records:

- exact command/scenario and timestamps when material;
- exit code/result plus concise interpretation;
- observed source/dirty basis and environment/runtime identity;
- relevant account/provider/platform/config identity without secrets;
- full raw artifact path;
- decisive excerpt, metric, state, response, trace, or screenshot;
- expected versus actual;
- which claim, finding, or QA row it decides.

Evidence that a command ran is not evidence that the product contract holds. Screenshots prove visible state, not persistence, authorization, or process/database correctness by themselves. An absence claim names its search patterns and basis.

## Completion state

No decision-material open question, suspected issue, failed row, changed/reconciled evidence gap, or unverified load-bearing claim may disappear during rewriting. Resolve it, reject it with evidence, mark it blocked/unreachable/out of scope with rationale, or carry it prominently into the verdict.

## Modular tracking

Every substantial workspace keeps observed basis/scope, risk questions, findings, validation, verdict, and residual risk. Plan outcomes, delegated lanes, QA matrices, compatibility, and fix-cluster sections are conditional modules: keep only those that affect the requested decision and delete unused sections instead of populating them ceremonially.

Read [output-modes.md](output-modes.md) for write authority, finding format, report order, and readiness language.
