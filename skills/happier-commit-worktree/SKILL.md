---
name: happier-commit-worktree
description: Reconnoiter, classify, validate, group, and commit a large or continuously changing Happier worktree as coherent, human-understandable commits while preserving concurrent work and excluding temporary, generated, QA, evidence, build, and other unwanted artifacts. Use when the user asks to commit many existing uncommitted changes, continue a long-running commit campaign, explain what remains, recover that campaign after compaction or interruption, or safely process newly landed changes in a shared dirty checkout. Do not use for an ordinary single-purpose commit whose scope is already known.
---

# Happier Commit Worktree

Turn an existing moving worktree into a sequence of reviewable commits without treating file count, directory boundaries, or the current index as truth. Preserve all bytes on disk, prove what each commit contains, and leave uncertain material uncommitted with a specific reason.

## 1. Establish authority and safety

Require an explicit user request to commit. Analysis alone does not authorize staging or commits.

Apply these invariants throughout:

- Never run `git reset`, `git restore`, `git clean`, `git checkout`, `git switch`, or an equivalent destructive operation.
- Never overwrite, delete, or normalize unrelated work merely to make status clean.
- Never trust or wholesale-commit the shared index. Stage every commit from explicit paths or hunks in a fresh private index.
- Treat the checkout as live. A path can change before, during, or after a commit.
- Serialize HEAD mutations even when reconnaissance and validation run in parallel.
- Use Conventional Commit subjects and explanatory bodies.
- Commit only changes whose intent, ownership, and suitability are understood.

Read [private-index-protocol.md](references/private-index-protocol.md) before the first commit in a campaign. Read [recovery-and-audit.md](references/recovery-and-audit.md) whenever the index is unusual, a process was interrupted, HEAD moved, a lock appeared, or the user asks whether everything was preserved.

## 2. Snapshot the current basis

Record compact observed evidence before grouping:

```bash
git rev-parse HEAD
git status --short
git diff --cached --name-status
git diff --stat
git ls-files --others --exclude-standard
```

Do not equate a clean shared index with a clean worktree. Do not equate an untracked path with source code. If the shared index is non-empty, inspect it before proceeding; never clear inherited staging by assumption.

Build a resumable inventory grouped by package, domain, change kind, and likely provenance. Re-snapshot after every commit batch because both HEAD and worktree bytes may have changed.

## 3. Run reconnaissance before committing

Use parallel agents only where they shorten the critical path. Give each lane a disjoint conceptual domain and require:

- candidate groups with exact paths and any hunk-level splits;
- the user or system behavior each group establishes;
- canonical owner, coupled tests, fixtures, schemas, docs, and generated contracts;
- suspected artifacts or uncertain paths and the evidence for exclusion;
- dependency ordering and validation commands;
- a proposed Conventional Commit subject and explanatory body.

Reconnaissance lanes do not stage or mutate Git unless explicitly assigned commit authority. A single orchestrator should normally perform HEAD updates. If multiple agents must commit, each uses a private index and compare-and-swap update from its observed parent; a stale agent rebuilds from the new HEAD rather than forcing or replaying blindly.

Follow the active subagent context policy. Default to no inherited transcript and provide a self-contained brief with exact scope, evidence, paths, checks, output, and stop conditions. Do not let lanes create ad hoc review files or use path "custody" as a substitute for checking current bytes and actual hunk collisions.

Read [grouping-and-messages.md](references/grouping-and-messages.md) for the classification rubric, artifact policy, commit sizing, and message standard.

## 4. Form coherent change packets

Group by one reviewable intent, invariant, migration, or user outcome, not by arbitrary path count. Include the complete slice needed to understand and verify that intent:

- canonical implementation and its directly coupled adapters;
- tests that define the behavior;
- required fixtures, types, schemas, migrations, and compatibility handling;
- consumed wiring and narrowly coupled documentation;
- tracked generated output only when the repository contract requires it.

Prefer useful batches, commonly 5-50 files and sometimes larger for uniform mechanical migrations, provider matrices, icon replacements, snapshots, or generated-contract updates. File count is a throughput heuristic, never permission to mix unrelated work. Avoid one-file commits when nearby changes complete the same idea, but keep a truly self-contained one-file correction separate.

Split a file by hunk when its changes serve different intents. Do not force an entire mixed file into the first convenient group.

Order packets by dependency: contracts and shared owners before consumers, implementation with defining tests, migrations before cleanup, and mechanical follow-ups after behavior is established.

## 5. Reject dumping grounds and unwanted material

Before staging an unfamiliar path, determine what produced it and whether it belongs in source control. Use current bytes, repository references, ignore rules, tracked history, build scripts, test harnesses, and timestamps as evidence. Typical exclusions include:

- build products, caches, compiler output, vendored downloads, archives, and oversized binaries;
- `.tmp*`, `.vite-node`, probes, logs, screenshots, recordings, coverage, evidence, and QA captures;
- local credentials, machine state, private diagnostics, and uploads;
- semantic no-ops, accidental formatting, obsolete scratch code, and speculative dormant mechanisms;
- tests or helpers whose production owner was removed unless the deletion itself is intentional and coherent.

Do not delete uncertain paths as part of committing. Leave them uncommitted and report why. Add a narrow ignore rule when the producer is legitimate, recurrence is likely, and the path class is never source material. Do not hide a tracked source path or broad directory merely to make status disappear.

## 6. Validate each packet

Inspect the exact private-index diff before creating a commit:

```bash
GIT_INDEX_FILE="$idx" git diff --cached --stat
GIT_INDEX_FILE="$idx" git diff --cached --check
GIT_INDEX_FILE="$idx" git diff --cached --name-status
GIT_INDEX_FILE="$idx" git diff --cached
```

Run the narrowest deciding tests and package checks appropriate to the packet. For pre-existing behavior changes, inspect whether tests and implementation agree rather than automatically changing whichever fails. Classify failures as a real defect, test drift, harness/environment failure, external-contract change, or unrelated concurrent failure.

`git commit-tree` does not run ordinary `pre-commit`, `prepare-commit-msg`, `commit-msg`, or `post-commit` hooks. Before the campaign's first commit, inspect repository hook policy and run the required hook-equivalent checks explicitly for every applicable packet and message. Preserve required signing policy rather than silently creating unsigned commits.

Check for accidental secrets and objects that violate the remote's file-size policy before committing large or binary material. Never solve a source-control size failure by assuming Git LFS or committing a vendor/build tree without establishing that repository policy requires it.

Do not claim a test or typecheck passed unless it ran. A coherent commit may proceed with a known unrelated failing check only when the failure is evidenced, unaffected, and disclosed in the commit campaign report.

## 7. Commit from a private index

Follow [private-index-protocol.md](references/private-index-protocol.md) exactly. The essential transaction is:

1. capture the current `HEAD` as the intended parent;
2. initialize a unique temporary index from that parent;
3. stage only the packet's explicit current paths and selected hunks;
4. inspect and validate the private staged diff;
5. create a commit object with `git commit-tree`;
6. advance `HEAD` with `git update-ref HEAD <commit> <expected-parent>`;
7. synchronize only committed paths in the shared index to the new HEAD;
8. verify the shared index and selected worktree paths.

Compare-and-swap is mandatory. If HEAD moved, discard only the temporary index and rebuild the packet from the new HEAD and current worktree bytes. Never force the ref and never assume the previously built tree can simply be attached to a different parent.

This transaction never rewrites the worktree. If new bytes land in a committed file after private staging, the committed snapshot becomes HEAD and the newer bytes remain visible as an uncommitted modification. That is the required behavior.

## 8. Reconcile after every commit

Immediately verify:

```bash
git show --stat --oneline --decorate -1
git diff --cached --name-status
git status --short -- <committed-paths...>
```

An `M` after the commit can be correct: compare HEAD, index, and worktree to determine whether later bytes remain. A staged deletion after a successful commit is usually an index-synchronization defect; explicitly remove the deleted path from the shared index as documented in the protocol.

Maintain a compact campaign ledger in the conversation or an already-approved tracking document, not a new ad hoc report file. Track completed commit ids, domain coverage, validation, residual groups, exclusions, and blockers. This is the anchor after compaction or interruption; always inspect live Git state before trusting it.

## 9. Close only after a residual audit

When no clear candidate group remains:

1. re-snapshot HEAD, shared index, tracked modifications, deletions, and untracked paths;
2. classify every residual path as newly landed source work, intentional artifact/exclusion, uncertain material, or an index anomaly;
3. verify no candidate group was lost between reconnaissance and commit;
4. inspect recent commits and aggregate their file/change statistics when requested;
5. report what was committed, checks run, failures or skipped checks, and every intentional residual category.

Say "everything appropriate is committed" only when every current residual path has an observed reason not to commit. Never shorten that to "everything is committed" when artifacts, uncertainty, later changes, or blockers remain.

Before handoff, run `skills/attack-conclusion`: challenge grouping coherence, missing siblings, artifact provenance, index cleanliness, concurrent-byte preservation, dependency ordering, and the possibility that a passing check did not exercise the changed contract.
