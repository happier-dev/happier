# Recovery and Residual Audit

## Contents

1. Recovery principle
2. Interrupted transaction diagnosis
3. Index anomalies and locks
4. Proving no work was lost
5. Residual classification
6. Campaign closeout

## 1. Recovery principle

Observe before mutating. The worktree, shared index, HEAD, reflog, and temporary private index are distinct states. Determine which transaction step completed; do not rerun the entire commit sequence by habit.

Never use destructive cleanup to recover. Do not run `reset`, `restore`, `clean`, `checkout`, or `switch`.

## 2. Interrupted transaction diagnosis

Capture:

```bash
git rev-parse HEAD
git log -5 --oneline --decorate
git reflog -10 --date=iso
git status --short
git diff --cached --name-status
git diff --name-status
```

Then classify:

- **Private staging only:** HEAD did not move. Remove only the known temporary index and rebuild later.
- **Commit object created, HEAD unchanged:** the object is unreachable or referenced only by its id. Do not attach it blindly; rebuild from current HEAD/current bytes.
- **HEAD advanced, index sync incomplete:** the commit already exists. Never create a duplicate commit. Synchronize its explicit paths from HEAD.
- **HEAD advanced and worktree remains dirty:** compare bytes. These may be legitimate later edits or excluded hunks.
- **HEAD moved by another writer:** inspect the new commits and rebuild the pending packet from that basis.

## 3. Index anomalies and locks

An unexpected `.git/index.lock` means another process may be mutating the index. Inspect it and its owner:

```bash
ls -l .git/index.lock
lsof .git/index.lock
```

Wait when a live owner exists. Remove a lock only after proving no process owns it and it is stale. A zero-byte file alone is not sufficient proof because a process may have just created it.

If shared-index synchronization failed after HEAD advanced:

1. verify the intended commit is current HEAD or an ancestor of it;
2. inspect its exact path list;
3. synchronize only those paths from the latest verified HEAD using the protocol;
4. handle deletions with `git update-index --remove`;
5. verify staged state is empty for those paths.

Never rebuild the entire shared index merely to repair a few known entries unless the user explicitly requested index reconstruction and all staged intent has been inventoried.

## 4. Proving no work was lost

"Git did not report an error" is not proof. Establish:

- the commit tree contains the intended snapshot;
- current worktree bytes are still present;
- excluded or later hunks appear in `git diff`;
- the shared index does not conceal or duplicate those hunks;
- deleted paths were intentional and are represented correctly;
- recent reflog entries explain every HEAD movement during the campaign.

For a disputed path, compare:

```bash
git show HEAD:<path> > /tmp/head-version 2>/dev/null || true
git show :<path> > /tmp/index-version 2>/dev/null || true
cp -- <path> /tmp/worktree-version 2>/dev/null || true
```

Compare hashes or diffs of those temporary files. Do not write any version back into the checkout during diagnosis.

For campaign statistics, select the exact commit range and use:

```bash
git diff --shortstat <parent-before-campaign>..<campaign-head>
git diff --numstat <parent-before-campaign>..<campaign-head>
git log --format='%H %s' <parent-before-campaign>..<campaign-head>
```

Distinguish unique paths in the range from the sum of per-commit file counts; a path changed by several commits is counted differently by those measures.

Audit newly introduced large blobs across the campaign range, not only current uncommitted files:

```bash
git rev-list --objects <parent-before-campaign>..<campaign-head> |
  git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' |
  awk '$1 == "blob" && $3 > 90000000 { print }'
```

An ignore rule does not remove a blob already present in a commit. If the audit finds an unwanted committed artifact, report its introducing commit and obtain explicit history-repair authority; do not rewrite or revert history as an automatic cleanup step.

## 5. Residual classification

At every pause and closeout, classify each residual path:

| Class | Action |
| --- | --- |
| Newly landed valid source work | Re-enter reconnaissance and grouping. |
| Intentional later hunk in a committed file | Keep dirty and assign to its proper packet. |
| Build/cache/download output | Exclude; add a narrow ignore rule when recurrence is proven. |
| QA/evidence/probe/log/upload | Exclude and protect private information. |
| Canonical tracked generated output | Pair with its source/generator change. |
| Unclear provenance or intent | Leave uncommitted and report the missing evidence. |
| Shared-index anomaly | Diagnose HEAD/index/worktree before further commits. |
| Real failing implementation/test | Repair through `skills/happier-implement` and `skills/happier-testing`, then regroup. |

Do not label all old files disposable. Modification time is supporting evidence only. Do not label all test failures blockers; determine whether they are caused by the candidate packet and whether they reveal production behavior or stale expectations.

## 6. Campaign closeout

Report:

- commit ids and human-readable subjects;
- domains/outcomes covered;
- exact validation run and its result;
- failed or skipped checks with cause;
- current tracked, deleted, untracked, and staged counts;
- residual categories and why each is not committed;
- any paths needing a future owner decision;
- aggregate file, insertion, and deletion statistics when requested.

Use precise conclusions:

- **Everything appropriate is committed:** all current residuals are evidenced exclusions, artifacts, or explicitly unresolved material.
- **More valid work remains:** identify the next coherent packets.
- **Blocked:** name the exact ambiguity, conflict, environment prerequisite, or failing owner behavior.

Never say "clean" when only the shared index is clean. Never say "all changes committed" when current bytes landed after the last snapshot.
