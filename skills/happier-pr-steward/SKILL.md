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

Inventory material contribution rather than using PR authorship as an attribution shortcut. For each planned commit, identify whose code, patch, design, causal diagnosis, decisive reproduction, or substantially adopted fix direction that commit actually incorporates. Resolve and add a verified `Co-authored-by:` trailer for each such contributor. The PR author normally earns co-authorship on commits that preserve or refactor their contributed code/intent, but not on independent steward fixes merely because they opened the PR. A newly derived fix for a reviewer finding does not transfer co-authorship to the PR author, and an automated reviewer does not create a human co-author claim. Review comments, participation, generic suggestions, requested logs, and confirmation alone do not qualify. Evaluate every commit independently, acknowledge useful non-qualifying help publicly, and stop before a commit only when a material contributor's required identity cannot be verified; never guess or expose an email.

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

Review and reporting alone are read-only. Present the evidence-backed recommendation before editing when the request did not already authorize implementation. If the user already asked for autonomous evidence-driven stewardship, that request may establish one bounded standing authorization immediately: acknowledge the repository/PR, allowed refinement and GitHub action classes, commit/push scope, exclusions, and terminal condition, then continue through narrow corrections that serve the stated PR outcome without pausing on the recommendation. Do not turn a valid standing grant into an initial ceremonial reapproval or repeated payload approvals later.

Exact approval covers only the described implementation batch; a standing grant covers its named outcome and action classes as evidence evolves. Return for a decision when new evidence requires a material product choice, architecture change, expanded scope, an action outside the standing grant, or a different cross-repository outcome.

## 5. Implement the approved source change first

Apply refinements on the PR branch. Use TDD for production behavior changes, inspect the final branch diff against the base, and validate in proportion to risk. Commit only related paths or hunks with a Conventional Commit message, the current local Git identity, and only the verified co-author trailers justified by material content in that commit.

## 6. Request review through the active authorization

Use `happier-github-ops` for comments, reviewer requests, thread actions, and any explicitly selected bot push. Git pushes otherwise use the current machine's normal Git transport and credentials. Under exact authorization, show the target and full outgoing text, including the required maintainer `cc`, and obtain approval for that payload. Under bounded standing authorization, post, request review, resolve addressed threads, and push covered corrections without returning for per-mutation approval; re-read current state first and report URLs/SHAs afterward. Never infer standing authority from a generic request to review or assess a PR.

Ordinary corrective commits and pushes use the current machine's configured Git identity and credentials. Re-read the live PR head repository and full head ref immediately before every push, then push an explicit source commit to that exact repository/ref with normal `git push`; never assume the base repository owns a fork PR's branch. Use `yarn ghops git push` only when the exact authorization or bounded standing grant specifically names `happier-bot` as the push actor; generic PR stewardship or failure of the current credentials is not enough. When a standing grant explicitly includes rebasing another author's PR, follow the foreign-PR rebase and exact force-with-lease rules in `happier-github-ops`; original authors remain authors, while the current machine identity remains the committer and default push actor.

Summarize what changed and why, name deciding checks, and ask the configured reviewers (including CodeRabbit and Greptile when requested) to review the current head.

## 7. Monitor and adjudicate, do not obey

Monitor the current head without busy-looping. Read all unresolved existing comments and reviews as well as new ones. For each finding:

1. reproduce or re-derive the claim from current source and tests;
2. separate the reported defect from the reviewer's proposed mechanism;
3. classify it as confirmed, already fixed, invalid, stale, or not applicable;
4. apply only confirmed, in-scope corrections using the canonical owner;
5. validate the affected repository, commit related-only changes with commit-specific attribution, then request review of the new head through the active exact or standing authorization.

Passing CI, an approval, or a bot confidence score is evidence, not authority. Conversely, a stale changes-requested state is not blocking when every underlying finding is proven fixed or irrelevant on the current head.

## 8. Finish on current-head facts

Continue until the current head is stable and:

- every existing and new finding has an evidence-backed disposition;
- all accepted changes are present in the PR branch;
- relevant current-head checks pass, or each failure is proven unrelated or unavailable;
- requested reviewers have reviewed the current head, declined, or have no remaining actionable feedback;
- no unresolved human thread identifies an unaddressed material issue.

Do not merge unless exact authorization or an explicit condition-bound standing grant includes the merge action and its deciding conditions. If external review or CI remains pending beyond the available monitoring window, report the head SHA, pending items, last observed state, and exact resumption point rather than declaring success.

Close with the merge recommendation, PR commit SHAs, validations actually run, dispositions of rejected findings, skipped checks, and residual risk.
