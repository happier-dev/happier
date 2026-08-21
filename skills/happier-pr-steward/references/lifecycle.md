# PR Stewardship Lifecycle

Use this compact state sequence. Keep state in the conversation and live GitHub/Git data; do not create a repository ledger, lease, receipt, or status file.

## 1. Intake

Capture:

- repository and PR number;
- base branch and SHA;
- head branch, repository, and SHA;
- PR author and verified commit identity;
- issue or product context;
- current review decision, review threads, comments, and check runs;
- dirty-state acknowledgement for every checkout used.

Refresh the head before a mutation or before treating a review/check as current.

## 2. Analysis report

Lead with the merge verdict. Support it with:

- observed intent and success condition;
- canonical owner and affected corridor;
- PR approach versus the independently derived simplest correct approach;
- duplicate, bypass, split-brain, compatibility, and test audit;
- concrete required and optional refinements;
- proposed source and destination validation;
- the exact human decision needed next.

Do not edit during this phase.

## 3. Approved implementation batch

For each batch:

1. refresh head and discussions;
2. implement and validate on the PR branch;
3. inspect the full base-to-head diff and related-only commit contents;
4. port by intent to every required destination;
5. validate and commit each destination without consuming unrelated bytes;
6. preview any GitHub mutation exactly and obtain approval;
7. push or post only the authorized payload;
8. record the new head and destination commit SHAs.

If the source head changes concurrently, rebase the reasoning on the current bytes without discarding work or force-updating history. Ask when the concurrent change conflicts with the approved intent.

## 4. Review loop

Use a small in-memory cursor:

- current head SHA;
- latest seen review/comment ids or timestamps;
- check-run identities and conclusions;
- each finding's disposition and evidence;
- source and destination commits containing accepted fixes.

Poll at a bounded cadence or use the available wait mechanism. A new head invalidates earlier current-head completion claims but not evidence that still applies. Do not repost merely to satisfy a ritual; request another review only after a meaningful new change or when a reviewer requires an explicit trigger.

For each finding, record the claim, observed evidence, impact, chosen response, source change, destination applicability, and deciding validation. Cluster findings with the same root cause into one coherent fix.

## 5. Human gates

Require a human decision for:

- the initial refinement and destination-port proposal;
- any material amendment or expanded product/design scope;
- destructive operations, force pushes, branch replacement, or conflict resolution that could discard work;
- every exact public GitHub mutation under `happier-github-ops`;
- merge, close, label, assignment, or other repository-state transitions.

An approved implementation batch may include its described code commits and push. New material findings require a renewed implementation decision; narrow fixes that directly satisfy the approved correctness outcome may proceed when the user explicitly asked for an evidence-driven fix loop.

## 6. Exit audit

Re-fetch the live PR. Verify:

- reported head equals the reviewed and tested head;
- no unresolved material thread was omitted;
- check results belong to that head;
- destination ports include every accepted intent, not merely matching filenames;
- commits contain only related changes and required co-authorship;
- rejected suggestions have concise factual reasons;
- merge has not occurred without exact authorization.
