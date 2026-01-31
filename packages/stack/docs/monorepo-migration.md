# Monorepo migration (split repos → `slopus/happy`)

This doc explains the **recommended, safe, step-by-step** flow to port commits from the legacy split repos (`happy`, `happy-cli`, `happy-server`) into the new `slopus/happy` monorepo layout:

- old `happy` (UI) → `expo-app/`
- old `happy-cli`  → `cli/`
- old `happy-server` → `server/`

The tooling used here is `hapsta monorepo port`. It ports commits by generating patches (`git format-patch`) and applying them with `git am` into the target monorepo branch.

## Quick start (if you don’t already use Happy Stacks)

If you’re an external collaborator and you **don’t** have `hapsta` installed yet, this is the fastest “migration environment” setup:

```bash
npx --yes -p @happier-dev/stack hapsta init --install-path
hapsta bootstrap --interactive
hapsta stack new monorepo-merge --interactive
```

### “No install” option (npx-only, port command only)

If you *only* want to run the port helper (and you already have local clones of the source repos + target monorepo), you can run it directly via `npx` without installing anything globally:

```bash
npx --yes -p @happier-dev/stack hapsta monorepo port --help
```

Example:

```bash
npx --yes -p @happier-dev/stack hapsta monorepo port \
  --target=/abs/path/to/slopus-happy-monorepo \
  --branch=your-port-branch \
  --base=origin/main \
  --3way \
  --from-happy=/abs/path/to/old-happy \
  --from-happy-base=origin/main
```

Notes:
- This “npx-only” mode is great for **one-off ports**, but it won’t manage stacks/worktrees for you.
- For the full guided flow (stacks + worktrees + repeatable commands), use the installed setup above.

### Port helpers (guide / status / continue)

Happy Stacks also provides small helpers that make conflict resolution less error-prone:

```bash
hapsta monorepo port guide
hapsta monorepo port status --target=/abs/path/to/monorepo
hapsta monorepo port continue --target=/abs/path/to/monorepo
```

- `port guide` is interactive (TTY required) and helps you build the initial port command safely.
- `port guide` can also **pause on conflicts**, let you resolve them, and then resume until the port completes.
- `port status` shows whether a `git am` session is in progress, the current patch subject, and conflicted files.
- `port continue` runs `git am --continue` for the target repo (after you staged resolved files). If you started from `port guide`, it can also resume the remaining port automatically after each continue.

### LLM-assisted conflict resolution (optional)

If you want to use an LLM to drive the port and resolve conflicts:

- **Best UX (guided)**: run `port guide` and pick **LLM** when it previews the first likely conflict.
- **Direct prompt helper**:

```bash
# Launch an LLM CLI in a new terminal (best-effort)
hapsta monorepo port llm --target=/abs/path/to/monorepo --launch

# Or: print + copy a prompt for copy/paste
hapsta monorepo port llm --target=/abs/path/to/monorepo --copy
```

Notes:
- Conflict resolution is **incremental**: `git am` stops at the **first** conflict; resolve it, then continue, and repeat.
- If no supported LLM CLI is installed (or terminal launching isn’t available), use `--copy` and paste into any LLM UI.

How to bring “the changes you want to port” into this environment:

- **If you already have local checkouts** of your legacy repos (recommended for forks/branches that aren’t PRs yet):
  - keep them wherever they are
  - you’ll pass their absolute paths to `hapsta monorepo port` via `--from-happy=...`, `--from-happy-cli=...`, etc.

- **If your changes exist as GitHub PRs**, you can let Happy Stacks create a clean worktree from the PR directly:
  - `hapsta wt pr happy-cli <pr-url-or-number> --use`
  - `hapsta wt pr happy <pr-url-or-number> --use`
  - (repeat for whichever repos your changes live in)

Once you have:
- a **target monorepo worktree** (from upstream), and
- one or more **source repos** (paths or worktrees)

…continue with the rest of this doc.

## Prereqs

- You have a **clean** source worktree/branch for each legacy repo you want to port.
  - No uncommitted changes (unless you intentionally want to include them as new commits first).
  - Ideally based on `upstream/main` (or you know the correct base ref).
- You have a **clean** target monorepo checkout (a worktree of `slopus/happy`).
- You are ready to resolve conflicts with `git am` (this is normal for large refactors, i18n changes, renamed files, etc).

## Recommended workflow (interactive, safest)

### 1) Create an isolated stack (don’t touch `main`)

Pick a new stack name (example: `monorepo-merge`):

```bash
hapsta stack new monorepo-merge --interactive
```

### 2) Create a clean monorepo worktree from upstream

Create a worktree based on `upstream/main` for the **monorepo** (`slopus/happy`):

```bash
hapsta wt new happy tmp/monorepo-port --from=upstream
```

Point your stack at that worktree (this keeps `main` stable):

```bash
hapsta stack wt monorepo-merge -- use happy /absolute/path/to/components/.worktrees/happy/slopus/tmp/monorepo-port
```

Notes:
- In monorepo mode, `happy`, `happy-cli`, and `happy-server` are **one git repo**; the stack overrides should point at the same monorepo root.
- `hapsta ... wt use happy <monorepo-root>` automatically updates all three component dir overrides together (prevents UI/CLI/server version skew).
- If you pass a monorepo root, Happy Stacks normalizes component dirs to:
  - `happy` → `.../expo-app`
  - `happy-cli` → `.../cli`
  - `happy-server` → `.../server`
 - Editor helpers open the **monorepo root** by default:
   - `hapsta wt cursor happy slopus/tmp/monorepo-port` (use `--package` to open just `expo-app/`, `cli/`, or `server/`).

### 3) Create a target branch

In the monorepo worktree, create your migration branch from `upstream/main`:

```bash
hapsta wt git happy slopus/tmp/monorepo-port -- checkout -b <your-branch-name> upstream/main
```

Example:

```bash
hapsta wt git happy slopus/tmp/monorepo-port -- checkout -b leeroy-wip upstream/main
```

### 4) Port the UI commits (old `happy` → `expo-app/`)

Run the port in **interactive mode**:

- use `--onto-current` to apply onto the branch you already checked out
- use `--3way` so git can do a 3-way merge and produce conflict markers instead of failing immediately
- **do not** use `--continue-on-failure` (you want it to stop at the first conflict)

```bash
hapsta monorepo port \
  --target=/abs/path/to/monorepo-root \
  --onto-current \
  --3way \
  --from-happy=/abs/path/to/old-happy-repo \
  --from-happy-base=upstream/main
```

What `--from-happy-base` means:
- It’s the ref used to compute the patch range (`merge-base(base, HEAD)..HEAD`).
- If your branch is based on `upstream/main`, this should be `upstream/main`.

### 5) Resolve conflicts (when the port stops)

If the port stops, you are now in a normal `git am` session.

Helpful commands:

```bash
git am --show-current-patch=diff
git status
```

Fix conflicts in the files with conflict markers:
- look for `<<<<<<<`, `=======`, `>>>>>>>`
- edit to the desired final content
- then stage the resolved files:

```bash
git add <file...>
git am --continue
```

If you decide a specific patch should not be ported:

```bash
git am --skip
```

If you want to fully abort the current patch application:

```bash
git am --abort
```

Then rerun the `hapsta monorepo port ... --onto-current ...` command.

### 6) Port the CLI commits (old `happy-cli` → `cli/`)

After the UI port completes, port CLI commits onto the same branch:

```bash
hapsta monorepo port \
  --target=/abs/path/to/monorepo-root \
  --onto-current \
  --3way \
  --from-happy-cli=/abs/path/to/old-happy-cli-repo \
  --from-happy-cli-base=upstream/main
```

Resolve conflicts the same way (`git am --continue`).

### 7) Verify what landed

Quick sanity checks:

```bash
# ensure upstream/main is an ancestor of your branch
git merge-base --is-ancestor upstream/main HEAD

# list commits introduced by the port
git log --oneline upstream/main..HEAD
```

If you are porting multiple legacy branches, it’s often useful to compare counts:

```bash
git rev-list --count upstream/main..HEAD
```

### 8) Push and open a PR

Push to the remote you intend to PR against (example uses `upstream`):

```bash
git push upstream HEAD:<branch-name>
```

## Common failures (expected) and what to do

### “target repo is not clean”

`hapsta monorepo port` refuses to run when the target has local changes.

Fix: commit, stash, or reset your target worktree, then re-run.

### “a git am operation is already in progress”

You have an unfinished `git am` session from a previous attempt.

Fix it first:

```bash
git am --continue   # after resolving conflicts
# or
git am --abort
```

Then re-run `hapsta monorepo port ...`.

### “patch does not apply” / i18n churn / renamed files

This usually means upstream moved and the patch context no longer matches.

Recommended: rerun with `--3way` (3-way merge) so you get conflict markers to resolve.

### “already exists in working directory”

This often happens when a commit (especially “new file”) was already folded into the monorepo history.

The tool auto-skips:
- patches that are already present (exact-match reverse apply check)
- pure new-file patches when the target already contains identical content

If you still hit this manually during a stopped `git am`, decide whether to:
- keep the existing file and `git am --skip`, or
- reconcile content and continue.

### Missing file path errors

If the patch references files that no longer exist (or moved) in the monorepo, you’ll need to:
- map the change to the new file location, or
- skip that patch if it’s obsolete.

Use `git am --show-current-patch=diff` to understand intent, then implement the equivalent change in the monorepo layout and continue.

## Optional: audit mode (best-effort report)

If you want a full report of what would apply vs fail (without stopping at the first conflict), you can run:

```bash
hapsta monorepo port ... --continue-on-failure --json
```

This is **not** the recommended way to produce a final clean branch, but it can be useful to:
- discover the full set of expected conflicts
- share a machine-readable report for assistance
