# Review Targets And Scope Basis

Choose the target from the user's requested decision, not from whichever Git command is easiest. Record intent basis, change basis, affected corridor, and exclusions separately; targets may compose.

## Target selection

### Plan completeness

Use when asked whether a plan, design, task list, migration, or prior agreement was fully implemented. Read the entire plan and its decision-relevant references, then use `plan-completeness.md`. The plan supplies intent; current code and runtime evidence decide implementation status.

Typical combination: plan intent + session/worktree/branch change basis + full affected corridor.

### Current session

Use when asked to review “what we changed,” “this session,” or the just-completed implementation. Reconstruct attributable edits from conversation/session evidence, explicit paths, and Git state. In a shared dirty worktree, do not absorb unrelated staged, unstaged, or untracked files merely because they are present.

### Full worktree

Use when asked to review all uncommitted/local changes. Include staged, unstaged, and untracked files, and record deletions and renames. Determine the intended branch/base separately. All explicit worktree changes are inventoried, while findings still distinguish unrelated concurrent work.

### Commit, range, branch, or PR

Use the exact commit/range or resolve the actual PR base and head. Read the stated intent and relevant commit/PR discussion. Do not assume `main`, do not treat a clean worktree as an empty branch review, and do not make unrelated pre-existing code a change-attributed finding.

### Feature or runtime flow

Use when the user names a feature, domain, provider flow, command, route, or user journey. Review its complete active implementation regardless of Git modification status: owners, entry points, readers/writers, cross-component seams, state/persistence, feature gates, providers, tests, compatibility, UI/CLI/API behavior, and same-concept alternate paths.

### Scoped codebase audit

Use when asked to assess architecture or quality without a particular change. Establish explicit packages/domains and risk questions. Report examined and unexamined surfaces; never imply whole-monorepo coverage from hotspot sampling.

### Release validation or sign-off

Use `skills/happier-release-validation` to run candidate validation and `skills/happier-release-validation-review` to review its evidence. This skill may audit a release-related change corridor, but it does not replace those operational protocols.

## The affected-corridor rule

Review scope has three rings:

1. **Explicit basis** — every changed/targeted item must be accounted for.
2. **Affected corridor** — inspect all unmodified code required to decide whether the target is correct: canonical owners, callers, callees, producers, consumers, readers, writers, parsers, serializers, schemas, persistence, lifecycle, compatibility, tests, and visible outputs.
3. **Broader discovery** — search outside the corridor for competing owners, duplicate registries, bypasses, and other consumers of the same contract. Expand only when evidence shows material coupling.

An unmodified pre-existing defect is in scope when the target builds on it, exposes it, creates a third path, or cannot be correct without resolving it. Label it `pre-existing-touched-corridor`. Otherwise record it as an unrelated observation without silently changing the requested deliverable.

## Basis commands

Use bounded, read-only Git commands appropriate to the target: `git status --short`, staged/unstaged name-status and stats, untracked inventory, explicit commit ranges, and the actual PR base. Save large diffs/logs outside the transcript and inspect them in relevant chunks. Git state proves what is on disk, not who authored it or why.

## Ambiguity rule

Infer the target when the wording and repository state make it clear. Ask one concise question only when alternatives materially change scope, authorization, or the verdict—for example, whether “current changes” means session-attributable edits or every dirty file in the shared checkout.
