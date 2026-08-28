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

Both configured fields must be present and the resolved author/committer must be the current local Git user. Do not set `GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `--author`, or temporary `user.*` overrides to impersonate a bot, PR author, issue author, or co-author. Contributor credit belongs in verified `Co-authored-by:` trailers. The foreign-PR rebase exception is owned by `skills/happier-github-ops` and does not apply to `commit-tree` packets.

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

Then create the commit without touching the worktree or shared index:

```bash
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
commit=$(git commit-tree "$tree" -p "$head" < /tmp/happier-commit-message.txt)
git show --no-patch --format=fuller "$commit"
git update-ref HEAD "$commit" "$head"
```

Before advancing, confirm the displayed author and committer match the previously verified current-user identity and inspect the full message with `git show --no-patch --format=fuller "$commit"` to verify exactly the commit-specific co-authors.

The message file contains the complete subject, blank line, and body. Remove it after use if it contains no information worth retaining; do not create message files inside the repository.

Verify the private diff is non-empty before `write-tree`; `commit-tree` can create an empty commit and does not apply the normal `git commit` policy checks for you.

`git update-ref` is compare-and-swap: it advances HEAD only if HEAD still equals `$head`. If it fails, do not force. Delete the temporary index, capture the new HEAD, and rebuild the staged packet from current bytes.

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

After `update-ref` succeeds, synchronize only the committed paths. Another authorized writer may already have advanced HEAD again, so first prove the created commit remains in current history and capture the latest tree.

For a multi-path packet, do not invoke `git update-index` once per path. That repeatedly acquires the shared index lock and exposes a long-lived partially synchronized index; an 800-path packet can temporarily appear as hundreds of staged modifications and false deletions. Build one deletion-aware NUL-delimited index-info stream outside the repository, verify its record count matches the exact packet manifest, then apply it through one `update-index` transaction:

```bash
sync_head=$(git rev-parse HEAD)
git merge-base --is-ancestor "$commit" "$sync_head"

index_info=$(mktemp -t happier-index-info.XXXXXX)
cleanup_index_info() {
  if test -e "$index_info"; then
    unlink "$index_info"
  fi
}
trap cleanup_index_info EXIT

for file_path in "${files[@]}"; do
  if git cat-file -e "$sync_head:$file_path" 2>/dev/null; then
    git ls-tree -z "$sync_head" -- "$file_path" >> "$index_info"
  else
    printf '0 0000000000000000000000000000000000000000\t%s\0' "$file_path" >> "$index_info"
  fi
done

record_count=$(tr -cd '\0' < "$index_info" | wc -c | tr -d ' ')
test "$record_count" -eq "${#files[@]}"
git update-index -z --index-info < "$index_info"
unlink "$index_info"
trap - EXIT
```

Do not use `path` as a loop or scalar variable in `zsh`: it is the shell's special array tied to `$PATH`, so assigning it can make commands such as `git` unavailable.

The zero-mode deletion record is mandatory. `git ls-tree` emits nothing for a deleted path; omitting an explicit deletion record leaves the old shared-index entry staged as a deletion. Use the per-path synchronization form only for a deliberately diagnosed repair of a small known subset, not as the ordinary large-packet transaction.

The batch must be prepared completely before `git update-index` starts. This reduces lock hold time and makes the shared-index transition atomic from observers' perspective. If acquiring the lock fails, HEAD is already advanced but the shared index remains in its previous complete state; follow the interrupted-synchronization recovery procedure rather than rebuilding or duplicating the commit.

This synchronization changes only index entries for selected paths. It does not write worktree files. A later worktree edit remains dirty against the committed/index blob. If a later commit changed the same path, synchronizing from `$sync_head` prevents the shared index from staging an accidental rollback to the older commit; treat that overlap as a collision and inspect both intents.

If the selected path had pre-existing shared staged bytes, this step replaces that selected index entry with the committed snapshot. That is why selected-path staging must be understood before the transaction.

## 5. Concurrency semantics

Private indexes isolate staging, not HEAD history. Use these rules:

- Every agent initializes from its own observed HEAD.
- Exactly one compare-and-swap can win from a given parent.
- A losing agent rebuilds from the new parent and current worktree; it never force-updates HEAD.
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
