# Worktrees + forks (hstack)

This repo is designed to run the **Happier** stack locally, while still making it easy to:

- keep using **your fork** day-to-day
- create **clean upstream PR branches** quickly (without carrying fork-only patches)

hstack is **monorepo-only**: UI/CLI/server all live in the same Happier git repo.

---

## Key idea

- Keep a stable checkout at `<workspace>/main`
- Put all development work in `<workspace>/dev` or repo worktrees under `<workspace>/{pr,local,tmp}/...`
- Point stacks at a repo checkout via **`HAPPIER_STACK_REPO_DIR`** (managed by `hstack wt use ...` / `hstack stack wt ...`)

---

## Layout

Default paths (see `hstack where` for your actual values):

- Stable checkout: `<workspace>/main`
- Dev checkout: `<workspace>/dev` (created by `hstack setup --profile=dev`)
- Worktrees:
  - PRs: `<workspace>/pr/...`
  - locals: `<workspace>/local/<owner>/...`
  - tmp: `<workspace>/tmp/<owner>/...`

Examples:

- `<workspace>/pr/123-fix-thing`
- `<workspace>/local/<owner>/my-feature`
- `<workspace>/tmp/<owner>/scratch`

Inside the monorepo, services live under:

- `apps/ui` (UI)
- `apps/cli` (CLI + daemon)
- `apps/server` (server; light/full flavors)

---

## Branch naming convention

Branches created/managed by `hstack` worktree tooling are typically named:

```
<owner>/<slug>
```

PR worktrees use `pr/...` branch names.

---

## Choosing which checkout hstack runs

hstack selects the active repo checkout using:

- `HAPPIER_STACK_REPO_DIR` (absolute path to the monorepo root)

Recommended ways to set it:

```bash
# Switch the active checkout for the current (non-stack) commands
hstack wt use pr/123-fix-thing

# Switch the active checkout for a specific stack
hstack stack wt pr123 -- use pr/123-fix-thing
```

If you want a one-shot override without changing the stack env file:

```bash
hstack stack typecheck pr123 --repo=pr/123-fix-thing
hstack stack build pr123 --repo=/absolute/path/to/checkout
```

---

## Creating worktrees

Create a new local worktree (recommended for day-to-day feature work):

```bash
hstack wt new my-feature --use
hstack wt push active --remote=origin
```

Use `--category=tmp` for truly throwaway worktrees.

---

## Testing a GitHub PR locally (`wt pr`)

Create a worktree at the PR head ref:

```bash
hstack wt pr https://github.com/happier-dev/happier/pull/123 --use

# or just the PR number (remote defaults to upstream)
hstack wt pr 123 --use
```

Update when the PR changes:

```bash
hstack wt pr 123 --update --stash
```

Notes:

- `--update` fails closed if the PR was force-pushed and the update is not a fast-forward; re-run with `--force`.
- `--slug=<name>` creates a nicer local branch name (example: `pr/123-fix-thing`).

---

## Switching server flavor (light vs full)

Choose which backend flavor a stack runs with:

```bash
hstack srv status
hstack srv use happier-server-light
hstack srv use happier-server
hstack srv use --interactive
```

Notes:

- This selects a runtime flavor (light/full). It does **not** select a different git repo.
- Both flavors come from the same monorepo server code (`apps/server`).
