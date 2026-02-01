# Worktrees + forks (hapsta)

This repo is designed to run the **Happier** stack locally, while still making it easy to:

- keep using **your fork** day-to-day
- create **clean upstream PR branches** quickly (without carrying fork-only patches)

Hapsta is **monorepo-only**: UI/CLI/server all live in the same Happier git repo.

---

## Key idea

- Keep a stable default checkout at `<workspace>/happier`
- Put all development work in repo worktrees under `<workspace>/.worktrees/<owner>/<branch...>`
- Point stacks at a repo checkout via **`HAPPIER_STACK_REPO_DIR`** (managed by `hapsta wt use ...` / `hapsta stack wt ...`)

---

## Layout

Default paths (see `hapsta where` for your actual values):

- Default repo checkout: `<workspace>/happier`
- Worktrees root: `<workspace>/.worktrees`
- Worktree path: `<workspace>/.worktrees/<owner>/<branch...>`

Examples:

- `<workspace>/.worktrees/slopus/pr/123-fix-thing`
- `<workspace>/.worktrees/happier-dev/local/my-fork-only-patch`

Inside the monorepo, services live under:

- `apps/ui` (UI)
- `apps/cli` (CLI + daemon)
- `apps/server` (server; light/full flavors)

---

## Branch naming convention

Branches created/managed by `hapsta` worktree tooling are named:

```
<owner>/<branch...>
```

Where:

- `<owner>` is derived from the remote you base from:
  - **origin/fork** → your fork owner (e.g. `happier-dev`)
  - **upstream** → upstream owner (e.g. `slopus`)
- `<branch...>` is whatever you choose (`pr/...`, `feat/...`, `local/...`, etc.)

---

## Choosing which checkout Hapsta runs

Hapsta selects the active repo checkout using:

- `HAPPIER_STACK_REPO_DIR` (absolute path to the monorepo root)

Recommended ways to set it:

```bash
# Switch the active checkout for the current (non-stack) commands
hapsta wt use slopus/pr/123-fix-thing

# Switch the active checkout for a specific stack
hapsta stack wt pr123 -- use slopus/pr/123-fix-thing
```

If you want a one-shot override without changing the stack env file:

```bash
hapsta stack typecheck pr123 --repo=slopus/pr/123-fix-thing
hapsta stack build pr123 --repo=/absolute/path/to/checkout
```

---

## Creating worktrees

Create a new worktree branch based on **upstream** (for upstream PRs):

```bash
hapsta wt new pr/my-feature --from=upstream --use
hapsta wt push active --remote=upstream
```

Create a new worktree branch based on **your fork** (for fork-only patches):

```bash
hapsta wt new local/my-patch --from=origin --use
hapsta wt push active --remote=origin
```

---

## Testing a GitHub PR locally (`wt pr`)

Create a worktree at the PR head ref:

```bash
hapsta wt pr https://github.com/leeroybrun/happier-dev/pull/123 --use

# or just the PR number (remote defaults to upstream)
hapsta wt pr 123 --use
```

Update when the PR changes:

```bash
hapsta wt pr 123 --update --stash
```

Notes:

- `--update` fails closed if the PR was force-pushed and the update is not a fast-forward; re-run with `--force`.
- `--slug=<name>` creates a nicer local branch name (example: `slopus/pr/123-fix-thing`).

---

## Switching server flavor (light vs full)

Choose which backend flavor a stack runs with:

```bash
hapsta srv status
hapsta srv use happy-server-light
hapsta srv use happy-server
hapsta srv use --interactive
```

Notes:

- This selects a runtime flavor (light/full). It does **not** select a different git repo.
- Both flavors come from the same monorepo server code (`apps/server`).
