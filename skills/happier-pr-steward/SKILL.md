---
name: happier-pr-steward
description: Analyze and shepherd a Happier 0.3 pull request from intent review through approved refinements, current-head CI and review follow-up, and evidence-based comment adjudication. Use when asked to assess whether a PR is correct or mergeable, detect duplicate or split-brain logic, add follow-up commits, request or monitor reviews, or address PR feedback on the 0.3 development line.
---

# Happier PR Steward

Own the PR lifecycle and its human gates. Delegate the actual review standard, implementation, testing, compatibility analysis, commit safety, and GitHub mutations to their canonical skills instead of duplicating them here.

## 1. Load the owning workflows

Use these skills as applicable:

- `skills/happier-review` for the review basis, affected corridor, findings, and merge assessment;
- `skills/happier-implement` and `skills/happier-testing` for approved behavior changes and RED -> GREEN evidence;
- `skills/happier-compatibility` when the PR changes released seams or version-skew behavior;
- `skills/happier-commit-worktree` when a checkout is large or actively dirty;
- `skills/happier-github-ops` for authenticated GitHub reads and every public mutation;
- `skills/verify-claims` before relying on bot, human, CI, or delegated claims;
- `skills/attack-conclusion` and `skills/handoff-report` for closeout.

Read [lifecycle.md](references/lifecycle.md) before starting.

## 2. Establish the live basis

Treat the PR body, patch, reviews, comments, approvals, and check results as claims. Fetch the current base and head SHAs, author identity, commits, complete diff, changed files, discussion, review threads, and checks. Record the head SHA for every analysis and re-check it before acting on a result.

Use a separate worktree for a foreign PR branch when needed. Never switch the primary checkout, discard local bytes, trust inherited staging, or mix unrelated work into a PR commit.

Resolve the PR author's verified commit identity before the first steward-authored commit. Every commit that carries the PR's intent or an accepted follow-up must include that author in a `Co-authored-by:` trailer. Stop before committing if the identity cannot be verified; never guess or expose an email.

## 3. Review intent before mechanism

Reconstruct the problem the PR is trying to solve from product behavior, issue context, code, history, and tests. Then independently determine how the task should be solved from the canonical owner.

Use `happier-review` to report:

- the real intent and observable success condition;
- the canonical owner, callers, readers, writers, tests, and compatibility paths;
- whether the PR matches that intent and owner;
- existing or introduced duplicate logic, split-brains, bypasses, and neighboring gaps;
- correctness, regression, security, compatibility, and test risks supported by evidence;
- the simplest coherent solution and any concrete refinements;
- a merge verdict: mergeable, mergeable after named refinements, or not recommended.

Do not invent speculative requirements or preserve machinery merely because it is already in the patch.

## 4. Pause at the recommendation gate

Review and reporting are read-only. Present the evidence-backed recommendation before editing, pushing, commenting, requesting reviews, or merging. Obtain explicit approval for the proposed refinement scope.

A prior approval covers only the described implementation batch. Return for a decision when new evidence requires a material product choice, architecture change, expanded scope, destructive action, or different cross-repository outcome.

## 5. Implement the approved source change first

Apply refinements on the PR branch. Use TDD for production behavior changes, inspect the final branch diff against the base, and validate in proportion to risk. Commit only related paths or hunks with a Conventional Commit message and the verified PR-author trailer.

## 6. Request review through an exact public preview

Use `happier-github-ops` for comments and reviewer requests. Before each mutation, show the exact target and full outgoing text, including the required maintainer `cc`, and obtain approval for that exact payload. General authorization to shepherd the PR does not waive this gate.

Summarize what changed and why, name deciding checks, and ask the configured reviewers (including CodeRabbit and Greptile when requested) to review the current head.

## 7. Monitor and adjudicate, do not obey

Monitor the current head without busy-looping. Read all unresolved existing comments and reviews as well as new ones. For each finding:

1. reproduce or re-derive the claim from current source and tests;
2. separate the reported defect from the reviewer's proposed mechanism;
3. classify it as confirmed, already fixed, invalid, stale, or not applicable;
4. apply only confirmed, in-scope corrections using the canonical owner;
5. validate the affected repository, commit related-only changes with attribution, then request review of the new head through a newly approved exact payload.

Passing CI, an approval, or a bot confidence score is evidence, not authority. Conversely, a stale changes-requested state is not blocking when every underlying finding is proven fixed or irrelevant on the current head.

## 8. Finish on current-head facts

Continue until the current head is stable and:

- every existing and new finding has an evidence-backed disposition;
- all accepted changes are present in the PR branch;
- relevant current-head checks pass, or each failure is proven unrelated or unavailable;
- requested reviewers have reviewed the current head, declined, or have no remaining actionable feedback;
- no unresolved human thread identifies an unaddressed material issue.

Do not merge unless the user separately authorizes that exact merge action. If external review or CI remains pending beyond the available monitoring window, report the head SHA, pending items, last observed state, and exact resumption point rather than declaring success.

Close with the merge recommendation, PR commit SHAs, validations actually run, dispositions of rejected findings, skipped checks, and residual risk.
