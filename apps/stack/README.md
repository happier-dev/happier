# Hapsta (Happier Stack)

Run [**Happier**](https://app.happier.dev) locally and access it remotely and securely (using Tailscale).

## What is Happier?

Happier is an UI/CLI stack (server + web UI + CLI + daemon) who let you monitor and interact with Claude Code, Codex and Gemini sessions from your mobile, from a web UI and/or from a desktop app.

## What is Hapsta?

Hapsta is a guided installer + local orchestration CLI for Happier.

If you only want to **use Happier** and self-host it on your computer, start with the **Self-host** section below.
If you want to **develop Happier** (worktrees, multiple stacks, upstream PR workflows), see the **Development** section further down.

## Self-host Happier (install + run)

### Quickstart

```bash
npx --yes -p @happier-dev/stack hapsta setup --profile=selfhost
```

Follow the guided instructions to install Happier and launch it.

### Daily use

#### Configure provider API keys for the daemon

If you want the daemon to have access to provider API keys (for example OpenAI), you can set them so they are automatically loaded when the daemon starts:

```bash
hapsta env set OPENAI_API_KEY=sk-...
```

Then restart so the daemon picks up the new environment:

```bash
hapsta start --restart
```

### Start Happier

Starts the local server, CLI daemon, and serves the pre-built UI.

```bash
hapsta start
```

### Authentication

On a **fresh machine**, the daemon needs to authenticate once before it can register a “machine”.

```bash
hapsta auth login
```

If you want a quick diagnosis:

```bash
hapsta auth status
```

### Enable Tailscale Serve (recommended for mobile/remote)

```bash
hapsta tailscale enable
hapsta tailscale url
```

### Mobile access

Make sure Tailscale is [installed and running](https://tailscale.com/kb/1347/installation) on your 
phone, then either:

- Open the URL from `hapsta tailscale url` on your phone and “Add to Home Screen”, or
- [Download the Happier mobile app]
([https://app.happier.dev](https://app.happier.dev)) and [configure it to use 
your local server](docs/remote-access.md).

Details (secure context, phone instructions, automation knobs): `[docs/remote-access.md](docs/remote-access.md)`.

## Development (worktrees, stacks, contributor workflows)

If you want to **develop Happier** (worktrees, multiple stacks, upstream PR workflows), you can install Hapsta for development with:

### Setup (guided)

```bash
npx --yes -p @happier-dev/stack hapsta setup --profile=dev
```

During setup, you’ll be guided through:

- where to store your **workspace** (the folder that will contain `happier/` and `.worktrees/`)
- bootstrapping/cloning the Happier monorepo
- **recommended**: setting up a dedicated `dev-auth` seed stack (authenticate once, then new stacks can reuse it)
- **recommended**: creating a dedicated dev stack (keep `main` stable)
- optional: installing the iOS dev-client app (for phone testing)

You can also set it non-interactively:

```bash
npx --yes -p @happier-dev/stack hapsta setup --profile=dev --workspace-dir=~/Development/happy
```

### Why this exists

- **Automated setup**: `hapsta setup` + `hapsta start` gets the whole stack up and running.
- **No hosted dependency**: run the full stack on your own computer.
- **Lower latency**: localhost/LAN is typically much faster than remote hosted servers.
- **Custom forks**: easily use forks of the Happier UI + CLI (e.g. `happier-dev/*`) while still contributing upstream to `slopus/*`.
- **Worktrees**: clean upstream PR branches without mixing fork-only patches.
- **Stacks**: run multiple isolated instances in parallel (ports + dirs + repo pinning).
- **Remote access**: `hapsta tailscale ...` helps you get an HTTPS URL for mobile/remote devices.

### How Hapsta wires “local” URLs

There are two “URLs” to understand:

- **Internal URL**: used by local processes on this machine (server/daemon/CLI)
  - typically `http://127.0.0.1:<port>`
- **Public URL**: used by other devices (phone/laptop) and embedded links/QR codes
  - recommended: `https://<machine>.<tailnet>.ts.net` via Tailscale Serve

Diagram:

```text
             other device (phone/laptop)
                   |
                   |  HTTPS (secure context)
                   v
        https://<machine>.<tailnet>.ts.net
                   |
                   | (tailscale serve)
                   v
           local machine (this repo)
     +--------------------------------+
     | happy-server-light OR          |
     | happy-server (via UI gateway)  |
     |  - listens on :PORT            |
     |  - serves UI at /              |
     +--------------------------------+
                   ^
                   | internal loopback
                   |
            http://127.0.0.1:<port>
               (daemon / CLI)
```

More details + automation: `[docs/remote-access.md](docs/remote-access.md)`.

### How it’s organized

- **Scripts**: `scripts/*.mjs` (bootstrap/dev/start/build/stacks/worktrees/service/tailscale/mobile)
- **Repo checkout**: `<workspace>/happier` (the monorepo clone)
- **Worktrees**: `<workspace>/.worktrees/<owner>/<branch...>`
- **CWD-scoped commands**: if you run `hapsta test/typecheck/lint` from inside `apps/ui` / `apps/cli` / `apps/server` and omit a target, Hapsta infers the “service” automatically; `hapsta build/dev/start` also prefer the checkout you’re currently inside.

### Quickstarts (feature-focused)

#### Remote access (Tailscale Serve)

```bash
hapsta tailscale enable
hapsta tailscale url
```

Details: `[docs/remote-access.md](docs/remote-access.md)`.

#### Worktrees + forks (clean upstream PRs)

Create a clean upstream PR worktree:

```bash
hapsta wt new pr/my-feature --from=upstream --use
hapsta wt push active --remote=upstream
```

Test an upstream PR locally:

```bash
hapsta wt pr https://github.com/leeroybrun/happier-dev/pull/123 --use
hapsta wt pr 123 --update --stash
```

##### Developer quickstart: create a PR stack (isolated ports/dirs; idempotent updates)

This creates (or reuses) a named stack, checks out the monorepo PR worktree, optionally seeds auth, and starts the stack.
Re-run with `--reuse` to update the existing worktrees when the PR changes.

```bash
hapsta stack pr pr123 \
  --repo=https://github.com/leeroybrun/happier-dev/pull/123 \
  --seed-auth --copy-auth-from=dev-auth --link-auth \
  --dev
```

Optional: enable Expo dev-client for mobile reviewers (reuses the same Expo dev server; no second Metro process):

```bash
hapsta stack pr pr123 --repo=123 --dev --mobile
```

Optional: run it in a self-contained sandbox folder (delete it to uninstall completely):

```bash
SANDBOX="$(mktemp -d /tmp/hapsta-sandbox.XXXXXX)"
hapsta --sandbox-dir "$SANDBOX" stack pr pr123 --repo=123 --dev
rm -rf "$SANDBOX"
```

Update when the PR changes:

- Re-run with `--reuse` to fast-forward worktrees when possible.
- If the PR was force-pushed, add `--force`.

```bash
hapsta stack pr pr123 --repo=123 --reuse
hapsta stack pr pr123 --repo=123 --reuse --force
```

##### Maintainer quickstart: one-shot “install + run PR stack” (idempotent)

This is the maintainer-friendly entrypoint. It is safe to re-run and will keep the PR stack wiring intact.

```bash
npx --yes -p @happier-dev/stack hapsta tools setup-pr \
  --repo=https://github.com/leeroybrun/happier-dev/pull/123 \
  --dev
```

Optional: enable Expo dev-client for mobile reviewers (works with both default `--dev` and `--start`):

```bash
npx --yes -p @happier-dev/stack hapsta tools setup-pr --repo=123 --dev --mobile
```

Optional: run it in a self-contained sandbox folder (auto-cleaned):

```bash
npx --yes -p @happier-dev/stack hapsta review-pr --happy=123 --happy-cli=456
```

Short form (PR numbers):

```bash
npx --yes -p @happier-dev/stack hapsta setup-pr --happy=123 --happy-cli=456
```

Override stack name (optional):

```bash
npx --yes -p @happier-dev/stack hapsta setup-pr --name=pr123 --happy=123 --happy-cli=456
```

Update when the PR changes:

- Re-run the same command to fast-forward the PR worktrees.
- If the PR was force-pushed, add `--force`.

```bash
npx --yes -p @happier-dev/stack hapsta setup-pr --happy=123 --happy-cli=456
npx --yes -p @happier-dev/stack hapsta setup-pr --happy=123 --happy-cli=456 --force
```

Details: `[docs/worktrees-and-forks.md](docs/worktrees-and-forks.md)`.

#### Server flavor (server-light vs full server)

- Use `happy-server-light` for a light local stack (no Redis, no Postgres, no Docker), and UI serving via server-light.
- Use `happy-server` when you need a more production-like server (Postgres + Redis + S3-compatible storage) or want to develop server changes for upstream.
  - Hapsta can **manage the required infra automatically per stack** (via Docker Compose) and runs a **UI gateway** so you still get a single `https://...ts.net` URL that serves the UI + proxies API/websockets/files.

Switch globally:

```bash
hapsta srv status
hapsta srv use --interactive
```

Switch per-stack:

```bash
hapsta stack srv exp1 -- use --interactive
```

Details: `[docs/server-flavors.md](docs/server-flavors.md)`.

#### Stacks (multiple isolated instances)

```bash
hapsta stack new exp1 --interactive
hapsta stack dev exp1
```

Point a stack at a PR worktree:

```bash
hapsta wt pr happy 123 --use
hapsta stack wt exp1 -- use happy slopus/pr/123-fix-thing
hapsta stack dev exp1
```

Details: `[docs/stacks.md](docs/stacks.md)`.

#### Dev stacks: browser origin isolation (IMPORTANT)

Non-main stacks use a stack-specific localhost hostname (no `/etc/hosts` changes required):

- `http://happy-<stack>.localhost:<uiPort>`

This avoids browser auth/session collisions between stacks (separate origin per stack).

#### Menu bar (SwiftBar)

```bash
hapsta menubar install
hapsta menubar open
```

Details: `[docs/menubar.md](docs/menubar.md)`.

#### Mobile iOS dev (optional)

```bash
# Install the shared Hapsta dev-client app on your iPhone:
hapsta mobile-dev-client --install

# Install an isolated per-stack app (Release config, unique bundle id + scheme):
hapsta stack mobile:install <stack> --name="Happier (<stack>)"
```

Details: `[docs/mobile-ios.md](docs/mobile-ios.md)`.

#### Reviewing PRs in an isolated sandbox

- **Unique hostname per run (default)**: `hapsta review-pr` generates a unique stack name by default, which results in a unique `happy-<stack>.localhost` hostname. This prevents browser storage collisions when the sandbox is deleted between runs.
- **Reuse an existing sandbox**: if a previous run preserved a sandbox (e.g. `--keep-sandbox` or a failure in verbose mode), re-running `hapsta review-pr` offers an interactive choice to reuse it (keeping the same hostname + on-disk auth), or create a fresh sandbox.

#### Tauri desktop app (optional)

```bash
hapsta build --tauri
```

Details: `[docs/tauri.md](docs/tauri.md)`.

### Commands (high-signal)

- **Setup**:
  - `hapsta setup` (guided; selfhost or dev)
  - (advanced) `hapsta init` (plumbing: shims/runtime/pointer env)
  - (advanced) `hapsta bootstrap --interactive` (workspace bootstrap wizard)
- **Run**:
  - `hapsta start` (production-like; serves built UI via server-light)
  - `hapsta dev` (dev; Expo dev server for UI, optional dev-client via `--mobile`)
- **Server flavor**:
  - `hapsta srv status`
  - `hapsta srv use --interactive`
- **Worktrees**:
  - `hapsta wt use --interactive`
  - `hapsta wt pr <pr-url|number> --use [--update] [--stash] [--force]`
  - `hapsta wt sync-all`
  - `hapsta wt update-all --dry-run` / `hapsta wt update-all --stash`
- **Stacks**:
  - `hapsta stack new --interactive`
  - `hapsta stack dev <name>` / `hapsta stack start <name>`
  - `hapsta stack edit <name> --interactive`
  - `hapsta stack wt <name> -- use --interactive`
  - `hapsta stack happy <name> -- <happy-cli args...>`
- **Tools (maintainer / automation)**:
  - `hapsta tools setup-pr --repo=<pr-url|number> [--dev|--start]`
  - `hapsta tools review-pr --repo=<pr-url|number> [--dev|--start]`
  - `hapsta tools review` (local diff review)
  - `hapsta tools import` (split repos → monorepo porting helpers)
  - `hapsta tools edison`
- **Menu bar (SwiftBar)**:
  - `hapsta menubar install`

### Docs (deep dives)

- **Remote access (Tailscale + phone)**: `[docs/remote-access.md](docs/remote-access.md)`
- **Server flavors (server-light vs server)**: `[docs/server-flavors.md](docs/server-flavors.md)`
- **Worktrees + forks workflow**: `[docs/worktrees-and-forks.md](docs/worktrees-and-forks.md)`
- **Stacks (multiple instances)**: `[docs/stacks.md](docs/stacks.md)`
- **Paths + env precedence (home/workspace/runtime/stacks)**: `[docs/paths-and-env.md](docs/paths-and-env.md)`
- **Menu bar (SwiftBar)**: `[docs/menubar.md](docs/menubar.md)`
- **Mobile iOS dev**: `[docs/mobile-ios.md](docs/mobile-ios.md)`
- **Tauri desktop app**: `[docs/tauri.md](docs/tauri.md)`

### Configuration

Where config lives by default:

- `~/.happier-stack/.env`: stable “pointer” file (home/workspace/runtime)
- `~/.happier-stack/env.local`: optional global overrides
- `~/.happier/stacks/main/env`: main stack config (port, server flavor, repo/worktree override)

Notes:

- Canonical env prefix is `HAPPIER_STACK_*` (no legacy aliases).
- Canonical stack storage is `~/.happier/stacks`.
- To edit per-stack environment variables (including provider keys like `OPENAI_API_KEY`), use:

  ```bash
  hapsta stack env <stack> set KEY=VALUE
  hapsta stack env <stack> unset KEY
  hapsta stack env <stack> get KEY
  hapsta stack env <stack> list
  ```

- **Repo env templates**:
  - **Use `.env.example` as the canonical template** (copy it to `.env` if you’re running this repo directly).
  - If an LLM tool refuses to read/edit `.env.example` due to safety restrictions, **do not create an `env.example` workaround**—instead, ask the user to apply the change manually.

### Breaking changes (vs “Happy Stacks”)

- No compatibility/migration for previous installs: uninstall old setups and run `hapsta setup` again.
- Env prefix is now `HAPPIER_STACK_*` (no legacy aliases like `HAPPY_STACKS_*` / `HAPPY_LOCAL_*`).
- Workspace/worktrees are monorepo-first (default: `~/.happier-stack/workspace` and `~/.happier-stack/workspace/.worktrees`).
- Yarn-only (no pnpm support).

### Sandbox / test installs (fully isolated)

If you want to test the full setup flow (including PR stacks) without impacting your “real” install, run everything with `--sandbox-dir`.
To fully uninstall the test run, stop the sandbox stacks and delete the sandbox folder.

```bash
SANDBOX="$(mktemp -d /tmp/hapsta-sandbox.XXXXXX)"

# Run a PR stack (fully isolated install)
npx --yes -p @happier-dev/stack hapsta --sandbox-dir "$SANDBOX" setup-pr --happy=123 --happy-cli=456

# Tear down + uninstall
npx --yes -p @happier-dev/stack hapsta --sandbox-dir "$SANDBOX" stop --yes --no-service
rm -rf "$SANDBOX"
```

Notes:

- Sandbox mode disables global OS side effects (**PATH edits**, **SwiftBar plugin install**, **LaunchAgents/systemd services**, **Tailscale Serve enable/disable**) by default.
- To explicitly allow those for testing, set `HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL=1` (still recommended to clean up after).

For contributor/LLM workflow expectations: `[AGENTS.md](AGENTS.md)`.

### Developing Hapsta itself

```bash
git clone https://github.com/leeroybrun/happier-dev.git
cd happier-dev

node ./apps/stack/bin/hapsta.mjs setup --profile=dev
```

Notes:

- For local dev, prefer running stack commands via the `hapsta` entrypoint (it applies stack-scoped env and safety gates).
- To make the installed `~/.happier-stack/bin/hapsta` shim (LaunchAgents / SwiftBar) run your local checkout without publishing to npm, set:

```bash
echo 'HAPPIER_STACK_CLI_ROOT_DIR=/path/to/your/happier-dev-checkout' >> ~/.happier-stack/.env
```

Or (recommended) persist it via init:

```bash
hapsta init --cli-root-dir=/path/to/your/happier-dev-checkout
```
