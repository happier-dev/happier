# Worktrees + forks (hapsta)

This repo is designed to run the Happy stack locally, while still making it easy to:

- keep using **your fork** day-to-day (your fork’s `main` stays your “distribution” branch)
- create **clean upstream PR branches** quickly (without carrying fork-only patches)

## Key idea: keep “active components” stable, put worktrees elsewhere

`hapsta` runs components from these default paths (in your workspace):

- `components/happy`
- `components/happy-cli`
- `components/happy-server-light`
- (optional) `components/happy-server`

All worktrees live under a hidden folder:

```
components/.worktrees/<component>/<owner>/<branch...>
```

Examples:

- `components/.worktrees/happy/slopus/pr/session-rename-upstream`
- `components/.worktrees/happy-cli/slopus/ci/typecheck-gha-upstream` (split-repo mode)
- `components/.worktrees/happy/happier-dev/local/my-fork-only-patch`

## Monorepo note (Happy UI/CLI/server in one repo)

When `happy`, `happy-cli`, and `happy-server` are checked out from the `slopus/happy` monorepo, they are **one git repo**.
In that mode, Hapsta stores worktrees under a single repo key:

```
components/.worktrees/happy/<owner>/<branch...>
```

and maps “logical components” to subdirectories:

- `happy` → `expo-app/`
- `happy-cli` → `cli/`
- `happy-server` → `server/`

## Branch naming convention

Branches created/managed by `hapsta` worktree tooling are named:

```
<owner>/<branch...>
```

Where:

- `<owner>` is derived from the repo remote you’re basing on
  - **origin** → usually your fork owner (e.g. `happier-dev`)
  - **upstream** → upstream owner (e.g. `slopus`)
- `<branch...>` is whatever you choose (`pr/...`, `feat/...`, `local/...`, etc.)

## Choosing which checkout hapsta runs

`hapsta` supports per-component directory overrides via the stack env file (main: `~/.happy/stacks/main/env`, or a specific stack: `~/.happy/stacks/<name>/env`):

- `HAPPIER_STACK_COMPONENT_DIR_HAPPY`
- `HAPPIER_STACK_COMPONENT_DIR_HAPPY_CLI`
- `HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER_LIGHT`
- `HAPPIER_STACK_COMPONENT_DIR_HAPPY_SERVER`

The easiest way to set these is with:

```bash
hapsta wt use happy slopus/pr/session-rename-upstream
hapsta wt use happy-cli slopus/pr/resume-session-from-ui-upstream
```

Now `hapsta dev`, `hapsta start`, and `hapsta build` will use those active checkouts.

## Switching server flavor (server-light vs full server)

You can persistently switch which server implementation is used by setting `HAPPIER_STACK_SERVER_COMPONENT` in the stack env file (main: `~/.happy/stacks/main/env`).

Use the convenience CLI (recommended):

```bash
hapsta srv status
hapsta srv use happy-server-light
hapsta srv use happy-server
hapsta srv use --interactive
```

Reset back to default:

```bash
hapsta wt use happy default
hapsta wt use happy-cli default
hapsta wt use happy-server-light default
hapsta wt use happy-server default
```

Note:
- `hapsta srv use ...` picks **which** server component is run.
- `hapsta wt use happy-server-light ...` / `hapsta wt use happy-server ...` pick **which checkout** is used for each server component.
- `hapsta start/dev/doctor` will error if these are accidentally mismatched (e.g. server-light selected but its component dir points inside a `happy-server` checkout).

## Creating worktrees

Create a new worktree branch based on **upstream** (for upstream PRs):

```bash
hapsta wt new happy pr/my-feature --from=upstream --use
```

## Testing a GitHub PR locally (`wt pr`)

If you have a GitHub PR URL (or just the PR number), you can create a worktree at the PR head ref:

```bash
hapsta wt pr happy https://github.com/slopus/happy/pull/123 --use

# same, but specify the remote explicitly
hapsta wt pr happy 123 --remote=upstream --use
```

Notes:
- This uses GitHub’s standard `refs/pull/<N>/head` ref on the chosen remote (default: `upstream`).
- To refresh the worktree when new commits are pushed to the PR, re-run with `--update`:

```bash
hapsta wt pr happy 123 --update
```

- If you have uncommitted changes in the PR worktree, you can use `--stash` / `--stash-keep`:

```bash
hapsta wt pr happy 123 --update --stash
```

- If the PR was force-pushed and the update is not a fast-forward, `--update` will abort and tell you to re-run with `--update --force`.
- Use `--slug=<name>` to create a nicer local branch name (example: `slopus/pr/123-fix-thing`).

### Testing a PR inside a stack (recommended)

Create a dedicated stack, then apply the PR into that stack env:

```bash
hapsta stack new pr123
hapsta stack wt pr123 -- pr happy https://github.com/slopus/happy/pull/123 --use
hapsta stack dev pr123
```

Create a new worktree branch based on **your fork** (for fork-only patches):

```bash
hapsta wt new happy local/my-patch --from=origin --use
```

### Remote + base behavior (automatic)

If you do **not** pass `--remote`, `hapsta wt new` defaults to using the Git remote named `upstream`.

It will also keep a local **mirror branch** named after the remote owner **and that remote’s default branch**:

- if `upstream` points at `slopus/*` and its default branch is `main`, it will create/update `slopus/main` tracking `upstream/main`
- if `origin` (or `fork`) points at `happier-dev/*` and its default branch is `happy-server-light`, it will create/update `happier-dev/happy-server-light` tracking `fork/happy-server-light`

New PR worktrees created without `--base` will default to using that mirror branch (example: `slopus/main`) as the base.

### Syncing a remote to a local mirror branch

`hapsta wt sync <component>` keeps a local mirror branch up to date inside that component repo:

- It fetches the remote’s **default branch** (for that remote + component)
- Then it updates a local branch named `<owner>/<default-branch>` to track it

Examples:

```bash
# Sync upstream (usually slopus/main)
hapsta wt sync happy --remote=upstream

# Sync your fork remote (origin/fork). For happy-server-light this is typically happier-dev/happy-server-light.
hapsta wt sync happy-server-light --remote=origin
```

After syncing, you can explicitly base a new worktree on the mirror branch if you want:

```bash
hapsta wt new happy pr/my-feature --remote=upstream --base=slopus/main --use
```

### Interactive mode

If you prefer prompts:

```bash
hapsta wt new --interactive
hapsta wt use --interactive
```

### JSON mode

For programmatic usage:

```bash
hapsta wt list happy --json
hapsta wt sync happy --json
hapsta wt new happy pr/my-feature --use --json
hapsta wt status happy --json
hapsta wt update happy default --dry-run --json
hapsta wt push happy default --dry-run --json
```

## Migrating old worktree layout (one-time)

## Workflow helpers (sync / update / push)

These are convenience commands to keep PR branches updated and to automate the “check conflicts first” loop.

### `wt status`

Shows branch / upstream / ahead/behind / clean state:

```bash
hapsta wt status happy
hapsta wt status happy --json
```

## Worktree selector semantics (`default` / `main` / `active`)

Many `hapsta wt` commands accept an optional “selector” argument to choose *which checkout* you mean.

- **(omitted)** or **`active`**: the currently active checkout for that component (env override if set; otherwise `components/<component>`)
- **`default`** or **`main`**: the default embedded checkout at `components/<component>`
- **`<owner>/<branch...>`**: resolves to `components/.worktrees/<component>/<owner>/<branch...>`
- **`/absolute/path`**: explicit checkout path

Important: `default` / `main` refers to the **checkout location**, not the Git branch name.

### `wt update`

Update a worktree branch from its upstream base.

- **Default base**: the per-repo mirror branch (example: `slopus/main`, or `happier-dev/happy-server-light` when syncing from your fork remote)
- **Default mode**: `rebase` (recommended for clean PR branches)

```bash
# Check if update would conflict (no changes applied)
hapsta wt update happy default --dry-run

# Apply rebase if clean; if conflicts, abort and print conflicting files
hapsta wt update happy default

# If you have uncommitted changes, auto-stash, update, then pop the stash back (only if the update was clean)
hapsta wt update happy default --stash

# Same, but keep the stash (do not pop) so you can apply it later
hapsta wt update happy default --stash-keep

# Keep conflict state in place for manual resolution
hapsta wt update happy default --force

# Use merge instead of rebase (optional)
hapsta wt update happy default --merge
```

## Open a “real” shell in a worktree (`wt shell`)

This starts a new interactive shell **with cwd set to the worktree**, which is the closest thing to a “real cd” a CLI can do:

```bash
hapsta wt shell happy slopus/pr/123

# choose a shell explicitly
hapsta wt shell happy slopus/pr/123 --shell=/bin/zsh
```

You can also ask it to open a new terminal window/tab (best-effort):

```bash
hapsta wt shell happy slopus/pr/123 --new-window
```

On macOS, auto-detection tries: Ghostty → iTerm → Terminal. You can override via:

- `HAPPIER_STACK_WT_TERMINAL=ghostty|iterm|terminal|current`
- `HAPPIER_STACK_WT_SHELL=/path/to/shell`

Works with stacks too:

```bash
hapsta stack wt pr123 -- shell happy active
```

Monorepo note:
- for monorepo worktrees, `wt shell` defaults to opening the **monorepo root**.
- to open the package dir instead, pass `--package` (e.g. `hapsta wt shell happy slopus/pr/123 --package`).

## Open in editors (`wt code` / `wt cursor`)

```bash
hapsta wt code happy slopus/pr/123
hapsta wt cursor happy slopus/pr/123
```

Notes:
- `wt code` requires VS Code’s `code` CLI on PATH.
- `wt cursor` uses the `cursor` CLI if available; on macOS it falls back to `open -a Cursor`.
- for monorepo worktrees, these commands open the **monorepo root** by default (so you see `expo-app/`, `cli/`, `server/` together).
- to open just the package dir, pass `--package`.

### `wt push`

Push current HEAD branch to a remote:

```bash
hapsta wt push happy default
hapsta wt push happy default --remote=origin
hapsta wt push happy default --dry-run
```

### Create worktrees from an existing worktree/branch

If you want to base a new worktree off another worktree’s current branch/HEAD:

```bash
hapsta wt new happy pr/next-step --base-worktree=slopus/pr/my-existing-thing
```

## Run git inside a worktree (`wt git`)

This is a convenience wrapper that runs `git` in a selected checkout:

```bash
hapsta wt git happy main -- status
hapsta wt git happy active -- log -n 5 --oneline
hapsta wt git happy slopus/pr/session-rename-upstream -- diff
```

For programmatic usage:

```bash
hapsta wt git happy main -- status --porcelain -b --json
```

## Sync/update everything

```bash
hapsta wt sync-all
hapsta wt sync-all --json

# Dry-run updates across all worktrees for a component (or all components if omitted)
hapsta wt update-all happy --dry-run
hapsta wt update-all --dry-run --json
```

If you previously had worktrees under `components/happy-worktrees/*`, run:

```bash
hapsta wt migrate
```

This will:

- move worktrees into `components/.worktrees/...`
- rename checked-out branches to the `<owner>/...` convention

## Server selection: happy-server-light vs happy-server

By default, `hapsta` uses `happy-server-light`.

To run the full upstream server instead:

```bash
hapsta bootstrap --server=happy-server
hapsta dev --server=happy-server
```

Notes:

- `hapsta start` (production-like) serves the built UI via `happy-server-light`; UI serving is **disabled** automatically when using `happy-server`.
- `hapsta dev` works with either server (it runs the UI separately via Expo).

### Selecting server via env (including LaunchAgent service)

You can set a default server implementation via:

- `HAPPIER_STACK_SERVER_COMPONENT=happy-server-light` (default)
- `HAPPIER_STACK_SERVER_COMPONENT=happy-server`

If you use the macOS LaunchAgent (`hapsta service install`), the service persists only a pointer to the env file path; the server flavor is read from that env file on every start.

## Env precedence (important)

When `hapsta` starts, it loads env in this order:

1) `~/.happier-stack/.env` (defaults)
2) `~/.happier-stack/env.local` (optional global overrides; most config is written to the stack env)
3) `HAPPIER_STACK_ENV_FILE` (stack env / explicit overlay; highest precedence)

Notes:

- `HAPPIER_STACK_ENV_FILE` is the mechanism used by `hapsta stack ...` to apply stack-specific settings.
- By default (after `hapsta init`), commands that “persist config” write to the main stack env file: `~/.happy/stacks/main/env`.

## Repo URLs

You can override clone sources in your main stack env file (`~/.happy/stacks/main/env`) or any explicit `HAPPIER_STACK_ENV_FILE`:

- `HAPPIER_STACK_REPO_SOURCE=forks|upstream`
- `HAPPIER_STACK_UI_REPO_URL`
- `HAPPIER_STACK_CLI_REPO_URL`
- `HAPPIER_STACK_SERVER_REPO_URL` (server-light/backwards compatible key)
- `HAPPIER_STACK_SERVER_LIGHT_REPO_URL`
- `HAPPIER_STACK_SERVER_FULL_REPO_URL`
