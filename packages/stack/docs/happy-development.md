# Happy component development (Happy Stacks)

This doc explains **how to develop the Happy components** using **Happy Stacks**:

- `happy` (UI)
- `happy-cli` (CLI + daemon)
- `happy-server-light` (SQLite “light” server)
- `happy-server` (Postgres “full” server)

It’s intended to be a “one-stop” guide for **humans and LLMs** to iterate safely and repeatably.

If you’re new to the project, start here:

- Self-hosting / running locally: `README.md`
- Worktrees + fork workflow: `docs/worktrees-and-forks.md`
- Stacks: `docs/stacks.md`
- Server flavors: `docs/server-flavors.md`
- Paths/env precedence: `docs/paths-and-env.md`
- Edison workflow (tasks/QA/evidence): `docs/edison.md`

---

## Core concepts (the mental model)

## Setup (recommended)

If you’re starting fresh, use the guided dev setup:

```bash
npx --yes -p @happier-dev/stack hapsta setup --profile=dev
```

This will guide you through workspace setup, bootstrapping components, and the recommended developer auth flow (`dev-auth` seed stack + optional mobile dev-client install).

### LLM helpers (optional)

Happy Stacks has “LLM prompt” helpers for the two most common “LLM is useful here” flows:

```bash
# Import + migrate legacy split repos (pre-monorepo)
hapsta import llm --mode=import --launch
hapsta import llm --mode=migrate --stack=<stack> --launch

# Port commits into a monorepo checkout (conflict-resolution helper)
hapsta monorepo port llm --target=/abs/path/to/monorepo --launch
```

If `--launch` isn’t available on your system, use `--copy` instead and paste the prompt into any LLM UI.

### Components

Happy Stacks is a launcher/orchestrator repo. The actual product code lives in component repos under:

- `components/happy`
- `components/happy-cli`
- `components/happy-server-light`
- `components/happy-server`

Split-repo mode: each component is its own Git repo.

Monorepo mode (new `slopus/happy` layout): `happy`, `happy-cli`, and `happy-server` can be a **single git repo**:

- `components/happy` is the monorepo root
- UI lives under `expo-app/`
- CLI lives under `cli/`
- server lives under `server/`

In monorepo mode, Happy Stacks can derive `happy-cli` + `happy-server` from the selected `happy` checkout to prevent version skew.
`happy-server-light` can be either:
- **integrated** into the monorepo `server/` package (when the server includes the SQLite schema at `server/prisma/sqlite/schema.prisma`, or legacy `server/prisma/schema.sqlite.prisma`), or
- still a **separate** component checkout (older layouts / non-monorepo setups).

Long-term, the goal is a single server package with multiple backends (“flavors”) rather than separate repos.

### Worktrees (where you do development)

**Never develop directly** in the default checkouts under `components/<component>`.
Treat them as **read-only launcher defaults**.

All development should happen inside **component worktrees** under:

```
components/.worktrees/<component>/<owner>/<branch...>
```

Worktrees make it easy to:

- keep your fork “distribution” branches stable
- create clean upstream PR branches
- work on multiple PRs/features in parallel

See: `docs/worktrees-and-forks.md`.

### Stacks (how you test changes safely)

A **stack** is an isolated runtime environment (ports + dirs + DB + CLI home) stored under:

```
~/.happy/stacks/<stack>/...
```

Stacks are configured by an env file:

```
~/.happy/stacks/<stack>/env
```

You should test worktrees inside a non-`main` stack (recommended).

See: `docs/stacks.md`.

### Server flavor (which backend you’re running)

You run exactly one server implementation per stack:

- **`happy-server-light`** (default): SQLite, serves built UI in “start” mode
- **`happy-server`** (full): Postgres + Redis + S3 (Minio), managed per stack (Docker Compose)

See: `docs/server-flavors.md`.

---

## Non‑negotiables (discipline that keeps stacks safe)

- **Use `hapsta` as the only entrypoint**
  - Don’t run raw `yarn`, `expo`, `tsc`, `docker`, etc. directly.
  - Hapsta needs stack-scoped env + runtime bookkeeping to stay isolated.
- **Develop only in worktrees**
  - Work inside `components/.worktrees/...`, not `components/<component>`.
- **Test/validate stack‑scoped**
  - Prefer `hapsta stack <stack> ...` commands (typecheck/lint/build/test/dev/start).
  - To run `happy-cli` against a specific stack: `hapsta stack happy <stack> -- <happy args...>` (stack shorthand: `hapsta <stack> happy ...`).
- **Do not “kill all daemons”**
  - Multiple stack daemons are expected.
  - If you use stack daemon **identities** (`--identity=<name>`), multiple daemons for the *same stack* can also be intentional.
  - Stop stacks explicitly (`hapsta stack stop …` or `hapsta stop …`), or stop a specific daemon identity (`hapsta stack daemon <stack> stop --identity=<name>`).
- **Main stack safety**
  - Avoid repointing `main` stack component dirs to worktrees. Use a new stack.
  - `hapsta wt use …` will warn/refuse for `main` unless you pass `--force`.

---

## Quickstarts (common development flows)

### 1) UI-only change (Happy UI)

Create a stack and point it at a UI worktree:

```bash
hapsta stack new ui1 --interactive

# Create a worktree (upstream-first recommended)
hapsta wt new happy pr/my-ui-change --from=upstream --use

# Pin the stack to that worktree
hapsta stack wt ui1 -- use happy slopus/pr/my-ui-change

# Run dev (server + daemon + Expo web)
hapsta stack dev ui1
```

Validate:

```bash
hapsta stack typecheck ui1 happy
hapsta stack lint ui1 happy
hapsta stack test ui1 happy
```

### 2) UI + CLI change (Happy + happy-cli)

```bash
hapsta stack new feat1 --interactive

hapsta wt new happy pr/resume-ui --from=upstream --use
hapsta wt new happy-cli pr/resume-cli --from=upstream --use

hapsta stack wt feat1 -- use happy slopus/pr/resume-ui
hapsta stack wt feat1 -- use happy-cli slopus/pr/resume-cli

hapsta stack dev feat1
```

Validate both:

```bash
hapsta stack typecheck feat1 happy happy-cli
hapsta stack lint feat1 happy happy-cli
hapsta stack test feat1 happy happy-cli
```

### 3) Developing server changes (full server)

Create a stack that uses `happy-server`:

```bash
hapsta stack new server1 --interactive
hapsta stack srv server1 -- use happy-server

hapsta wt new happy-server pr/my-server-fix --from=upstream --use
hapsta stack wt server1 -- use happy-server slopus/pr/my-server-fix

hapsta stack dev server1
```

Notes:

- Full server stacks may manage per-stack infra automatically (Postgres/Redis/Minio) via Docker Compose.
- Use stack-safe commands to stop infra cleanly: `hapsta stack stop server1` (or `hapsta stop …`).

### 4) Testing an upstream PR locally

```bash
hapsta wt pr happy 123 --slug=123-fix-thing --use
hapsta stack new pr123
hapsta stack wt pr123 -- use happy slopus/pr/123-fix-thing
hapsta stack dev pr123
```

---

## Worktrees: upstream-first workflow + fork integration

Happy Stacks is designed for an **upstream-first** workflow:

- Implement on an **upstream-based** worktree/branch (`--from=upstream`).
- Open a clean PR to upstream (`slopus/*`) when appropriate.
- Then validate/ship to your fork via **test-merge → cherry-pick fallback** (in a fork-based worktree).

See the full guide: `docs/worktrees-and-forks.md`.

### Concrete walkthrough: upstream PR → fork integration

This is the most common “ship it everywhere without polluting history” flow.

#### 1) Create an upstream-based worktree and implement

Example: implement a UI fix intended for upstream:

```bash
hapsta wt new happy pr/my-ui-fix --from=upstream --use
```

Notes:

- When you use `--from=upstream`, the worktree branch name is owner-prefixed. This example produces a branch named:
  - `slopus/pr/my-ui-fix`

Do your work inside the worktree path under `components/.worktrees/...`.

When ready, push to upstream:

```bash
hapsta wt push happy active --remote=upstream
```

#### 2) Validate the same commits on your fork (test-merge)

Create a fork-based “integration” worktree (temporary branch) and try merging the upstream branch into it:

```bash
hapsta wt new happy tmp/merge-pr-my-ui-fix --from=origin --use
```

Then merge the upstream branch/commit(s) inside that worktree:

```bash
# optional: confirm the upstream branch name before merging
hapsta wt status happy slopus/pr/my-ui-fix --json

hapsta wt git happy active -- merge --no-ff slopus/pr/my-ui-fix
```

If it merges cleanly, push to your fork and open a fork PR:

```bash
hapsta wt push happy active --remote=origin
```

#### 3) If it conflicts: cherry-pick fallback

If the test-merge conflicts, abort the merge, then cherry-pick the upstream commits onto a fork PR branch/worktree and resolve conflicts there:

```bash
hapsta wt git happy active -- merge --abort

# cherry-pick the upstream commits you want (examples):
hapsta wt git happy active -- cherry-pick <commit1> <commit2>
```

Notes:

- This keeps the upstream PR history clean and makes fork PRs reproducible.
- The same pattern applies to `happy-cli` and server repos too.

### Server repos: shipping the same change to both fork flavors (split-repo workflow)

Server development has one extra twist: **our fork uses a single GitHub repo with two “main” branches**.

- **Upstream repo**: `slopus/happy-server` (base branch typically `main`)
- **Fork repo**: `happier-dev/happy-server-light`
  - full server fork “main” branch: `happy-server`
  - light server fork “main” branch: `happy-server-light`

Local checkouts:

- **Split-repo mode (legacy):** `components/happy-server` and `components/happy-server-light` are separate clones, so branch names do not automatically exist in both.
- **Unified monorepo mode (recommended):** server flavors share a single codebase under `components/happy/.../server/` and Happy Stacks can point both `happy-server` and `happy-server-light` component dirs at that same monorepo checkout when the SQLite artifacts exist (see `docs/server-flavors.md`).
- In the split server repos, the fork remote name is often `fork` (not `origin`), but **`hapsta wt` normalizes `origin` ↔ `fork`** automatically.

#### Goal: one upstream PR, two fork PRs (one per target branch)

1) Implement on an upstream-based worktree (recommended use the full server component):

```bash
hapsta wt new happy-server pr/my-server-fix --from=upstream --use
```

Push upstream (to open the upstream PR):

```bash
hapsta wt push happy-server active --remote=upstream
```

2) Check out that upstream PR in the other local server component too (so you can reuse the exact same commits there).

Example (use the upstream PR URL/number):

```bash
hapsta wt pr happy-server-light https://github.com/slopus/happy-server/pull/<N> --use
```

3) For each fork flavor, create a fork-based integration worktree and merge the PR branch into it, then push.

Full server fork branch (`happy-server`):

```bash
hapsta wt new happy-server tmp/merge-pr-my-server-fix --from=origin --use
hapsta wt status happy-server --json
# merge the upstream PR branch name shown by wt/pr (example: slopus/pr/<N>-<slug>)
hapsta wt git happy-server active -- merge --no-ff slopus/pr/<N>-<slug>
hapsta wt push happy-server active --remote=origin
```

Light server fork branch (`happy-server-light`):

```bash
hapsta wt new happy-server-light tmp/merge-pr-my-server-fix --from=origin --use
hapsta wt status happy-server-light --json
# merge the upstream PR branch name shown by wt/pr (example: slopus/pr/<N>-<slug>)
hapsta wt git happy-server-light active -- merge --no-ff slopus/pr/<N>-<slug>
hapsta wt push happy-server-light active --remote=origin
```

Then open **two PRs** to `happier-dev/happy-server-light`:

- one targeting base branch `happy-server`
- one targeting base branch `happy-server-light`

If a merge conflicts, use the same **cherry-pick fallback** described above, but do it separately for each fork target branch/worktree.

High-signal commands:

- **Sync mirror branches** (update local `<owner>/<defaultBranch>` mirrors):

```bash
hapsta wt sync-all
```

- **Update worktrees** (rebase/merge against mirrors):

```bash
hapsta wt update-all --dry-run
hapsta wt update-all --stash
```

- **Switch active checkout**:

```bash
hapsta wt use happy slopus/pr/my-feature
hapsta wt use happy default
```

---

## Running: `start` vs `dev`

### `hapsta start` (production-like)

- Runs the stack in a stable mode.
- Typically serves a built UI via `happy-server-light` (unless using full server with UI gateway).

### `hapsta dev` (development)

Runs the “full local dev loop”:

- **server** (light or full, per stack)
- **daemon** (`happy-cli`) pointing at that server
- **UI** via Expo web dev server

### Web UI origin isolation (IMPORTANT)

When running **non-main stacks**, Happy Stacks will use a stack-specific localhost hostname:

- `http://happy-<stack>.localhost:<uiPort>`

This intentionally creates a **unique browser origin per stack** so browser storage (localStorage/cookies) does not collide between stacks (which can otherwise cause “no machine” / auth confusion).

### Browser auto-open (`--no-browser`)

In interactive TTY runs, `hapsta dev` / `hapsta start` may auto-open the UI in your browser.

- Disable: `--no-browser`
- Stack mode uses the stack-specific hostname shown above (not plain `localhost`) for correctness.

**Dev reliability features** (implemented in Happy Stacks):

- **Dependency install**: ensures component deps are installed when needed.
- **Schema readiness**:
  - `happy-server` (Postgres): applies `prisma migrate deploy` (configurable via `HAPPIER_STACK_PRISMA_MIGRATE`)
  - `happy-server-light` (SQLite):
    - **unified** server-light (recommended): applies `prisma migrate deploy` using the SQLite migration history in the unified server repo (`prisma/sqlite/schema.prisma` — legacy: `prisma/schema.sqlite.prisma`)
    - **legacy** server-light: does **not** run `prisma migrate deploy` (it often fails with `P3005` when the DB was created via `prisma db push` and no migrations exist). The legacy server-light dev/start scripts handle schema via `prisma db push`.
- **Auth seeding for new stacks** (non-main + non-interactive default):
  - Uses the configured seed stack via `HAPPIER_STACK_AUTH_SEED_FROM` (default: `main`) when the stack looks uninitialized.
  - Recommended for development: create + log into a dedicated seed stack once (usually `dev-auth`) and set:
    - `HAPPIER_STACK_AUTH_SEED_FROM=dev-auth`
    - `HAPPIER_STACK_AUTO_AUTH_SEED=1`
  - This copies credentials/master secret and seeds the minimal DB rows (Accounts) without copying full DB files.

---

## “Smart builds” + watch mode (hot-reload-ish)

### happy-cli build behavior

`hapsta dev` / `hapsta start` will ensure `happy-cli` is built when needed:

- If `dist/index.mjs` is missing, it builds.
- If source/deps changed since the last build, it rebuilds (git-based signature cache).

Controls:

- `HAPPIER_STACK_CLI_BUILD_MODE=auto|always|never`
- `HAPPIER_STACK_CLI_BUILD=0` to hard-disable build

### Watch mode

In interactive TTY runs, `hapsta dev` enables a watcher by default (disable with `--no-watch`):

- **happy-cli changes** → rebuild CLI + restart daemon
- **happy-server changes** (full server only, where we run `start`) → restart server

Important:

- Server watch is **stack-only** and is enabled only when Happy Stacks can identify the current **stack-owned server PID**.
  - If the server was already running and the PID can’t be resolved, `dev` will disable server watch and tell you to re-run with `--restart`.

Why only full server gets an external watcher:

- `happy-server-light` upstream `dev` already provides the correct dev loop.
- `happy-server` upstream `dev` is not stack-safe, so we run `start` and add our own watcher.

### Runtime state + ports during restarts

When watchers restart components:

- Happy Stacks updates per-stack runtime state with the **new PIDs**
- It reuses the **same ports** for the run (restarts reuse the same `PORT`)
  - Ports are allocated once per `stack dev/start` invocation and are kept stable for the lifetime of that run.

See “Process isolation + runtime state” below.

---

## Developer-only: set up a `dev-auth` seed stack + dev UI key

This is a **one-time developer machine setup**. LLM agents should **not** do this; agents should only consume existing seeds/keys.

### Create the seed stack (wizard)

Run:

```bash
hapsta stack create-dev-auth-seed
```

This will (interactive, in a TTY):

- create (or reuse) the `dev-auth` stack
- start a temporary server + Expo UI
- guide you through creating/restoring an account in the UI
- prompt to save the dev key locally (never committed)
- run `hapsta stack auth dev-auth login` to authenticate the CLI/daemon for that seed stack

### Make it the default seed for new stacks

Add to `~/.happier-stack/env.local`:

```bash
HAPPIER_STACK_AUTH_SEED_FROM=dev-auth
HAPPIER_STACK_AUTO_AUTH_SEED=1
```

### Repair / seed existing stacks (bulk)

```bash
hapsta auth copy-from dev-auth --all --except=main,dev-auth
```

If you have full-server (`happy-server`) stacks and want seeding to bring up infra automatically:

```bash
hapsta auth copy-from dev-auth --all --except=main,dev-auth --with-infra
```

### Print the UI-accepted dev key format (for UI login / agents)

```bash
hapsta auth dev-key --print
```

By default, in a TTY this prints the UI “backup” format (`XXXXX-...`). For automation, use `--format=base64url`.

---

## Process isolation + runtime state (why stops/restarts are safe)

Happy Stacks is “stack-safe” by design:

- It tracks PIDs it starts (runner/server/UI/daemon)
- It refuses to kill processes unless they look **owned by the target stack**
  - ownership is validated using process env (stack name + env file path)

### Runtime state file

Non-persisted runtime details (ephemeral ports + PIDs) live in:

```
~/.happy/stacks/<stack>/stack.runtime.json
```

This file is intentionally separate from the stack env file:

- Env file = stable configuration you *intend* to persist
- Runtime state = transient state for the currently running processes

### Stopping stacks safely

Stop a single stack:

```bash
hapsta stack stop <stack>
```

Stop everything except main:

```bash
hapsta stop --except-stacks=main --yes
```

Useful flags:

- `--aggressive`: stops daemon-tracked sessions (but still only stack-owned)
- `--sweep-owned`: final “owned process sweep” (kills any remaining processes that still have the stack env in their process env)
- `--no-docker`: skip managed infra shutdown (when you know Docker is irrelevant)

---

## Validation commands (typecheck / lint / build / test)

Run against the **active checkouts**:

```bash
hapsta typecheck
hapsta lint
hapsta build
hapsta test
```

Run stack-scoped (recommended when developing):

```bash
hapsta stack typecheck <stack> [component...]
hapsta stack lint <stack> [component...]
hapsta stack build <stack>
hapsta stack test <stack> [component...]
```

Examples:

```bash
hapsta stack typecheck exp1 happy happy-cli
hapsta stack lint exp1 happy
hapsta stack test exp1 happy-cli
```

---

## CLI reference (high-signal)

Most commands support `--help` and `--json`.

### Core run commands

- **`hapsta start`**: production-like run (no Expo)
  - Flags: `--server=happy-server|happy-server-light`, `--restart`, `--no-daemon`, `--no-ui`, `--no-browser`, `--mobile`
- **`hapsta dev`**: dev run (server + daemon + Expo web)
  - Flags: `--server=happy-server|happy-server-light`, `--restart`, `--no-daemon`, `--no-ui`, `--watch`, `--no-watch`, `--no-browser`, `--mobile`
- **`hapsta stop`**: stop stacks and related processes
  - Flags: `--except-stacks=main,exp1`, `--yes`, `--aggressive`, `--sweep-owned`, `--no-docker`, `--no-service`

### TUI (optional)

If you want a split-pane view while running a command:

```bash
hapsta tui stack dev <stack>
```

### Stack-scoped commands

All `hapsta stack <name> ...` commands apply that stack’s env file (and keep stacks isolated).

- **Lifecycle**:
  - `hapsta stack new <name> [--interactive] [--server=...] [--port=...] [--copy-auth-from=main|--no-copy-auth]`
  - `hapsta stack dev <name>`
  - `hapsta stack start <name>`
  - `hapsta stack stop <name> [--aggressive] [--sweep-owned] [--no-docker]`
  - `hapsta stack build <name>`
- **Quality**:
  - `hapsta stack typecheck <name> [component...]`
  - `hapsta stack lint <name> [component...]`
  - `hapsta stack test <name> [component...]`
- **One-shot component overrides (do not persist)**:
  - Many stack commands accept one-shot overrides like `--happy=...` / `--happy-cli=...` / `--happy-server-light=...` / `--happy-server=...`
  - Example:

```bash
hapsta stack typecheck exp1 --happy=slopus/pr/my-ui-pr happy
```
- **Selection / diagnosis / auth**:
  - `hapsta stack wt <name> -- <wt args...>`
  - `hapsta stack srv <name> -- use happy-server|happy-server-light`
  - `hapsta stack doctor <name>`
  - `hapsta stack auth <name> status|login|copy-from <seed>`
  - `hapsta stack audit --fix-workspace --fix-paths --fix-ports`

### Worktrees

- `hapsta wt new <component> <branch> --from=upstream|origin --use`
- `hapsta wt pr <component> <pr-url|number> --use [--update] [--stash]`
- `hapsta wt use <component> <spec>`
- `hapsta wt sync-all`
- `hapsta wt update-all [--dry-run] [--stash]`

### Edison wrapper (mandatory in this repo)

- `hapsta edison --stack=<stack> -- <edison args...>`
- `hapsta edison --stack=<stack> -- evidence capture <task-id>`

---

## Useful environment knobs (high-signal)

Hapsta uses `HAPPIER_STACK_*` as the canonical env prefix.

- **Server flavor**:
  - `HAPPIER_STACK_SERVER_COMPONENT=happy-server-light|happy-server`
- **Ports**:
  - `HAPPIER_STACK_SERVER_PORT=<n>` (pinned)
  - `HAPPIER_STACK_EPHEMERAL_PORTS=1` (prefer ephemeral ports for stacks; default for non-main stacks)
- **Full server infra** (happy-server):
  - `HAPPIER_STACK_MANAGED_INFRA=0` (disable Docker-managed Postgres/Redis/Minio; provide URLs yourself)
- **Prisma behavior**:
  - `HAPPIER_STACK_PRISMA_MIGRATE=0` (full server: disable `prisma migrate deploy`)
- **happy-cli build behavior**:
  - `HAPPIER_STACK_CLI_BUILD_MODE=auto|always|never`
  - `HAPPIER_STACK_CLI_BUILD=0` (hard-disable)

See also: `docs/paths-and-env.md` for env precedence and where the files live.

---

## Debug / inspect commands

- **“Where is this running from?”**:

```bash
hapsta where
hapsta where --json
```

- **Stack health / diagnosis**:

```bash
hapsta stack doctor <stack>
```

- **Fix common stack hygiene issues** (foreign component paths, inconsistent dirs, port collisions):

```bash
hapsta stack audit --fix-workspace --fix-paths --fix-ports
```

- **Stop stacks safely**:

```bash
hapsta stack stop <stack>
hapsta stop --except-stacks=main --yes
```

---

## Edison integration (tasks/QA/evidence/validation)

Edison is supported in this repo, but **does not provide isolation** here.
Isolation is provided by **Happy Stacks** (stacks + component worktrees).

Key rule: **do not run `edison ...` directly** in this repo.
Use the wrapper:

```bash
hapsta edison --stack=<stack> -- evidence capture <task-id>
```

This wrapper:

- forces stack-scoped env
- fingerprints the correct multi-repo state
- enables fail-closed guards (task → stack → worktrees)

See: `docs/edison.md`.

---

## Troubleshooting (high-signal fixes)

### “No machine” / auth required

Check auth:

```bash
hapsta stack auth <stack> status
```

Login (interactive):

```bash
hapsta stack auth <stack> login
```

Multiple accounts on one stack (optional): use an identity and disable auto browser open so you can choose the
browser profile/account you authenticate as:

```bash
hapsta stack auth <stack> login --identity=account-a --no-open
hapsta stack auth <stack> login --identity=account-b --no-open
```

Start/stop a specific identity daemon:

```bash
hapsta stack daemon <stack> start --identity=account-a
hapsta stack daemon <stack> stop  --identity=account-a
```

Non-interactive repair (copy credentials + seed accounts from `main`):

```bash
hapsta stack auth <stack> copy-from <seed>
```

Notes:

- `<seed>` should be the stack you use as your auth seed (recommended: `dev-auth`).
- Creating/logging into the seed stack is a **developer-only** setup step; agents should only consume it.

### Port collisions / foreign component paths / weird stack dirs

Run the audit fixer:

```bash
hapsta stack audit --fix-workspace --fix-paths --fix-ports
```

### Stack is unhealthy / can’t reach server

```bash
hapsta stack doctor <stack>
```
