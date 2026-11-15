# Private Index Commit Protocol

## Contents

1. Preconditions
2. Whole-path transaction
3. Partial-hunk transaction
4. Shared-index synchronization
5. Concurrency semantics
6. Post-commit verification

## 1. Preconditions

Use this protocol only after explicit commit authorization and coherent grouping. Never use plain shared-index `git add` or `git commit` for a moving shared worktree.

Resolve the ordinary commit identity from the checkout before preparing the private index:

```bash
git config --get user.name
git config --get user.email
git var GIT_AUTHOR_IDENT
git var GIT_COMMITTER_IDENT
```

Both configured fields must be present and the resolved author/committer must be the current local Git user. Do not set `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `--author`, or temporary `user.*` overrides to impersonate a bot, PR author, issue author, or co-author. Contributor credit belongs in verified `Co-authored-by:` trailers. The foreign-PR rebase exception is owned by `.agents/skills/happier-github-ops` and does not apply to `commit-tree` packets.

Capture the basis and inspect inherited staging:

```bash
head=$(git rev-parse HEAD)
git diff --cached --name-status
```

If a selected path is already staged in the shared index, identify those staged bytes before proceeding. Do not overwrite another intent. Unrelated staged paths can remain, but the final audit must report them; a clean shared index is preferred because it makes synchronization failures visible.

The filesystem is authoritative for preserving the user's current bytes. The shared index is separately owned staging state and may be stale, partial, or wrong. Never make the worktree match the index as a recovery shortcut. In particular, treat a staged deletion for a path that still exists on disk as an anomaly until its exact bytes and owner are understood.

Do not create private indexes, locks, message files, patch files, manifests, or recovery state beneath `.project`. Before the first transaction, verify that forbidden local-state paths are neither tracked nor staged. Put temporary files outside the repository. If serialization beyond compare-and-swap is useful, place the lock beneath `git rev-parse --git-common-dir`; CAS remains mandatory.

Expand candidate directories to an exact file list before staging. The synchronization loop operates on files, symlinks, gitlinks, and deletions; passing a directory tree entry to `update-index` is not equivalent to synchronizing its children. Check that the packet is non-empty and that every path belongs to the repository.

Inspect `git config --get core.hooksPath` and relevant `.git/hooks` or repository hook wrappers before using `commit-tree`. It bypasses normal commit hooks. Run required staged-diff and commit-message checks explicitly, and use the repository's signing mechanism when signed commits are required.

## 2. Whole-path transaction

Use an array so whitespace and glob characters are preserved:

```bash
files=(
  'path/to/file-one.ts'
  'path/with spaces/file-two.ts'
)

idx=$(mktemp -t happier-commit.XXXXXX)
cleanup_private_index() {
  if test -e "$idx"; then
    unlink "$idx"
  fi
}
trap cleanup_private_index EXIT
head=$(git rev-parse HEAD)

GIT_INDEX_FILE="$idx" git read-tree "$head"
GIT_INDEX_FILE="$idx" git add -- "${files[@]}"
GIT_INDEX_FILE="$idx" git diff --cached --check
GIT_INDEX_FILE="$idx" git diff --cached --name-status
GIT_INDEX_FILE="$idx" git diff --cached
```

Confirm the diff contains exactly the intended paths and bytes. Compare the private staged path list with the explicit packet manifest in a stable, NUL-safe form. For every whole-path addition or modification, verify the staged blob id equals `git hash-object -- <filesystem-path>` immediately before creating the tree. For a deletion, verify the path is absent on disk and the deletion was explicitly selected. For a partial-hunk path, compare the staged patch rather than requiring whole-file blob equality.

If any selected filesystem path changes after verification, rebuild or re-verify that path. Never silently commit the older private-index bytes while claiming the current filesystem version was captured.

Then create the tree and use the checker-owned finalizer to prove it type-resolves (SKILL.md section 7) and commit without touching the worktree or shared index:

```bash
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
finalization=$(node scripts/workspaces/checkCommitTypeCoherence.mjs --base="$head" --tree="$tree" --message-file=/tmp/happier-commit-message.txt) || exit "$?"
printf '%s\n' "$finalization"
commit=$(printf '%s\n' "$finalization" | sed -n 's/^committed \([0-9a-f]*\):.*/\1/p')
git show --no-patch --format=fuller "$commit"
```

**Fast path (default for lane commits, owner 2026-11-07).** Skip the finalizer. After the focused tests and entry-loads pass:

```bash
node scripts/git/commitFromPrivateIndex.mjs --message-file /tmp/happier-commit-message.txt -- "${files[@]}"
```

This canonical fast path creates a fresh private index from HEAD, stages exact files, checks the diff, refuses the packet when the commit checker's producer-closure scan (`commitProducerClosure`, exported by `scripts/workspaces/checkCommitTypeCoherence.mjs`; owner 2026-11-15, blocking) finds a new missing module, missing named export or lockfile importer without a tracked `package.json` in the packet's tree, creates the commit, advances HEAD by compare-and-swap, and synchronizes only its changed paths in the shared index. Run from the repository root. It rejects directories, empty packets and `.project` paths; it never force-adds ignored files or changes working-tree bytes. Review whole-path bytes before invocation. For mixed files, pass `--patch-file /tmp/selected.patch` and list only whole-path files after `--`; the patch is applied only to the private index.
The script captures one HEAD for both the private tree and parent. If CAS loses, it rebuilds from the new HEAD and reapplies the selected files and patch; a conflicting patch refuses instead of overwriting intervening commits. The shared-index update is part of every fast-path commit (owner-approved 2026-11-14, INDEX-SYNC-FASTPATH-1114), replacing the earlier instruction to leave it stale. The exact-tree finalizer remains available only for a pre-push HEAD coherence pass or an explicit exact-tree request.

Verify the current-user identity and complete commit-specific co-authors in the message before invoking the finalizer, and inspect the created object with `git show --no-patch --format=fuller "$commit"` afterwards. The finalizer uses ordinary `git commit-tree` configuration, including configured signing; required hook-equivalent checks remain the caller's responsibility.

Invoke the checker directly on the Git-owning machine for every packet. The Git-only changed-source decision skips compiler loading and admission for zero-TS packets, including replay and finalization. On Unix hosts, TS packets replace the CLI with canonical shell admission before loading compiler modules or Git blobs, so the CLI heap is released while queued. The admitted checker and API launcher reuse that reservation; an outer wrapper is unnecessary. Native Windows retains its existing native API path.

The message file contains the complete subject, blank line, and body. Remove it after use if it contains no information worth retaining; do not create message files inside the repository.

Verify the private diff is non-empty before `write-tree`; `commit-tree` can create an empty commit and does not apply the normal `git commit` policy checks for you.

The finalizer advances HEAD by compare-and-swap. If HEAD moved during the check or CAS, it replays only this packet onto the new parent in an external temporary index and compares that tree with the checked tree. It reuses groups whose resolved verdict inputs did not change, including unrelated module edits within the same project and intervening edits that were reverted. The compiler resolves those inputs from checked roots plus the complete program's declarations, scripts and augmentations; changes to other configured modules that introduce global context or alter imports still invalidate the verdict. Only intersecting or newly discovered importer groups run again. Conflicting packet edits, new diagnostics, or unowned roots refuse finalization without changing HEAD. A human-readable check log from an earlier process is not a reusable in-memory result: invoke this combined command rather than a separate stale-base finalizer. The exported `checkCommitTypeCoherence` and `finalizeCommitTypeCoherence` APIs also support this combined flow in one process.

## 3. Partial-hunk transaction

When a selected file contains unrelated work:

1. initialize the private index from the captured HEAD;
2. stage any whole files in the packet;
3. create a temporary patch containing only the intended complete hunks;
4. review the patch independently;
5. apply it only to the private index;
6. inspect the resulting staged diff before writing the tree.

```bash
GIT_INDEX_FILE="$idx" git apply --cached --check /tmp/selected.patch
GIT_INDEX_FILE="$idx" git apply --cached /tmp/selected.patch
GIT_INDEX_FILE="$idx" git diff --cached -- <mixed-file>
```

Do not edit the worktree to manufacture a clean file. Do not use zero-context fragments that can apply ambiguously. Include sufficient context and keep whole semantic hunks together. If the worktree changes and invalidates the patch, regenerate it from current bytes.

After committing a partial file, synchronize its full committed HEAD blob into the shared index. The uncommitted hunks stay in the worktree and therefore remain visible as `M` relative to HEAD.

## 4. Shared-index synchronization

The canonical fast-path script synchronizes the commit's exact changed file paths after CAS succeeds. It reads the latest HEAD, proves the commit is still an ancestor, and prepares one deletion-aware, NUL-delimited `update-index --index-info` batch. Additions, symlinks and gitlinks use tree modes and object IDs; removed files use explicit zero-mode records. Literal pathspecs preserve whitespace and wildcard characters. Unrelated shared-index entries are untouched; excluded or later worktree edits remain dirty.

Git acquires its ordinary index lock for the single batch. On contention the script waits for filesystem change notifications and retries with fresh HEAD records. It never deletes another writer's lock or imposes a competing timeout. An abandoned lock requires its owner's diagnosis; interrupting a wait does not undo the commit.

If the process is interrupted after CAS, its stderr identifies the created commit. Resume synchronization without making another commit:

```bash
node scripts/git/commitFromPrivateIndex.mjs --sync-commit <created-commit>
```

Recovery derives the selected paths from that commit, proves ancestry and uses the same synchronization owner. Selected-path staging is replaced by HEAD, so understand any pre-existing staged bytes for selected paths before committing. A concurrent later edit of the same path is a genuine collision requiring inspection; unrelated packets can proceed concurrently. The exact-tree coherence finalizer does not invoke this fast path; after an explicitly requested finalization, use this same recovery command to synchronize its committed paths.

## 5. Concurrency semantics

Private indexes isolate staging, not HEAD history. Use these rules:

- Every agent initializes from its own observed HEAD.
- Exactly one compare-and-swap can win from a given parent.
- A losing finalizer replays the reviewed packet onto the new parent and rechecks only intersecting groups; it never force-updates HEAD. Worktree changes after packet verification remain uncommitted and visible.
- Do not create commits in separate checkouts and cherry-pick them blindly when the source checkout is moving. A cherry-pick replays a historical patch and cannot prove which current bytes should remain dirty.
- A custom lock can reduce retries but does not replace CAS. A private index prepared before acquiring a lock can still have a stale parent.
- Store an optional custom lock beneath the Git common directory, never in `.project` or another worktree path. Record enough ownership information to distinguish a live owner from a stale lock, and use bounded waits with periodic user-visible progress rather than an unbounded loop.
- Prefer parallel reconnaissance, manifest preparation, and independent validation with one serial commit authority. Parallel writers are justified only for genuinely disjoint packets and must still tolerate CAS retries.

## 6. Post-commit verification

Verify the committed object, index, and worktree separately:

```bash
git merge-base --is-ancestor "$commit" HEAD
git show --format=fuller --stat "$commit"
git diff --cached --name-status
git status --short -- "${files[@]}"
```

For a path still marked modified, compare all three states:

```bash
git diff HEAD -- <path>
git diff --cached -- <path>
git diff -- <path>
```

Expected moving-worktree result:

- `HEAD` and shared index contain the committed snapshot;
- worktree contains any later or deliberately excluded hunks;
- `git diff --cached` is empty for the path;
- `git diff` shows only residual bytes.

Always unlink the temporary index and temporary patch/message files after verification. Prefer explicit `unlink` calls because some agent command policies correctly reject generic `rm -f` cleanup even for temporary files.
