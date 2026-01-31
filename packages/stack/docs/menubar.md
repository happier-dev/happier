# Menu bar (SwiftBar)

`hapsta` ships a macOS menu bar plugin powered by [SwiftBar](https://swiftbar.app/).

SwiftBar runs a script on an interval and renders its output as native macOS menu items.

## Features

- **Status at a glance** with dynamic icons (green/orange/red)
  - Server health
  - Daemon status (PID + optional control server probe)
  - Autostart LaunchAgent status
  - Tailscale Serve status / URL (if configured)
- **Quick controls**
  - Start / stop / restart the stack
  - Restart just the daemon (stack-safe)
  - Install / enable / disable / uninstall autostart
  - Enable / disable Tailscale Serve
- **Details**
  - PID, CPU %, RAM MB, uptime (where available)
  - Useful URLs and file paths
  - Stack details include aggregate CPU/RAM (server+daemon+autostart) when running
  - Open logs in Console.app
- **Refresh control**
  - Manual refresh
  - In-menu refresh interval toggles (includes slower intervals like 10m/15m/30m/1h/6h/12h/1d)
  - Uses a small helper script (`extras/swiftbar/set-interval.sh`) to avoid SwiftBar quoting issues
- **Stacks + components layout**
  - Main stack is shown directly (no extra nesting level)
  - Each stack shows component rows (Server/Daemon/Autostart/Tailscale) with per-component submenus
 - **Components (git/worktrees)**
  - Available under a top-level **Components** submenu (to keep the main menu clean)
  - Shows repo/worktree status for each component under `components/`
  - Monorepo-aware: component dirs can point at subdirectories (e.g. `.../expo-app`, `.../cli`, `.../server`) and still show git/worktree info
  - Each component includes a **Worktrees** submenu listing all worktrees, with actions to switch/open
  - Quick actions: `wt status/sync/update`, PR worktree prompt, open shells/editors (`wt shell/code/cursor`)
  - Shows **origin** and **upstream** comparisons for the component repo’s main branch (based on your last `git fetch`)
  - Uses a **Git cache** by default so SwiftBar refresh stays fast even with many stacks/worktrees

## Modes: selfhost vs dev

The menu supports two modes:

- **Selfhost mode** (`selfhost`): lightweight “control panel” for running Happier.
  - Shows only the main stack essentials (Server/Daemon/Autostart/Tailscale) plus a small **Maintenance** section.
  - Hides developer-oriented sections like stacks enumeration, components git/worktrees, and worktree tooling.
- **Dev mode** (`dev`): full stack control plane (stacks + components + worktrees).

### How to switch modes

- In the menu, use the **Mode** section at the top, or
- From a terminal:

```bash
hapsta menubar mode selfhost
hapsta menubar mode dev
```

## Stacks (multiple instances)

If you create additional stacks (see `docs/stacks.md`), the plugin shows:

- **Main stack** (the default, stack name `main`)
- **Stacks** section listing each stack found under `~/.happy/stacks/<name>/env`

Each stack row renders the same “mini control panel” (server/daemon/autostart/logs + a few actions) with stack-specific ports, dirs, and LaunchAgent label.

The menu also includes:

- `stack new --interactive` (create stacks)
- `stack edit <name> --interactive` (edit stack port/server flavor/worktrees)
- `stack wt <name> -- use --interactive` (switch component worktrees inside a stack)
- “PR worktree into this stack (prompt)” (creates `wt pr ... --use` scoped to the stack env)

## Worktrees (quick entry points)

The menu also provides “jump off” actions for the worktree tooling:

- `hapsta wt use --interactive`
- `hapsta wt new --interactive`
- `hapsta wt sync-all`
- `hapsta wt update-all --dry-run` / `hapsta wt update-all`
- `hapsta wt pr ...` (via an in-menu prompt)

For stack-specific worktree selection (which components a stack uses), use:

- `hapsta stack edit <name> --interactive`
  - or `hapsta stack wt <name> -- use --interactive`

### Monorepo note (worktree switching)

In **monorepo stacks**, `happy`, `happy-cli`, and `happy-server` typically point into the same git repo.
To avoid version skew, the menu does **not** offer per-component “use this worktree” actions for these components.
Use the stack-level selector instead (it will switch the monorepo checkout and derive the rest):

- `hapsta stack wt <name> -- use happy --interactive`

## Implementation notes

- **Entry script**: `extras/swiftbar/hapsta.5s.sh` (installed into SwiftBar as `hapsta.<interval>.sh`)
- **Shared functions**: `extras/swiftbar/lib/*.sh` (sourced by the entry script)
- **Helper scripts**:
  - `extras/swiftbar/set-interval.sh`
  - `extras/swiftbar/set-server-flavor.sh`

## Install

### 1) Install SwiftBar

```bash
brew install --cask swiftbar
```

### 2) Install the plugin

```bash
hapsta menubar install
```

If you want a different default refresh interval at install time:

```bash
HAPPIER_STACK_SWIFTBAR_INTERVAL=15m hapsta menubar install
```

### 3) Open the active SwiftBar plugin folder

SwiftBar can be configured to use a custom plugin directory. To open the *active* one:

```bash
hapsta menubar open
```

## Uninstall

Remove the installed SwiftBar plugin files (does not delete your stacks/workspace):

```bash
hapsta menubar uninstall
```

## How refresh works (important)

SwiftBar’s refresh interval is controlled by the **filename** suffix:

- `hapsta.30s.sh` → every 30 seconds
- `hapsta.5m.sh` → every 5 minutes
- `hapsta.1h.sh` → every 1 hour

The plugin defaults to a slower interval (recommended), and also sets:

- `refreshOnOpen=false` (recommended) to avoid surprise refreshes while you’re navigating the menu.

You can also change the interval directly from the menu via **Refresh interval** (it renames the plugin file and restarts SwiftBar).

## Git cache (important for performance)

Git/worktree inspection is the most expensive part of the menu when you have many stacks.
By default, the plugin runs in **cached mode**:

- It renders git/worktree info from an on-disk cache under `~/.happier-stack/cache/swiftbar/git`.
- Normal menu refreshes do **not** run git commands (so refresh stays snappy).
- The cache is refreshed explicitly (via menu actions), and can optionally refresh on TTL expiry.

Controls and settings:

- **Refresh now**: open **Components → Git cache** and run:
  - “Refresh now (main components)”
  - “Refresh now (all stacks/components)”
  - or “Refresh now (this stack)” from a stack’s Components menu
- **TTL**: `HAPPIER_STACK_SWIFTBAR_GIT_TTL_SEC` (default `21600` seconds = 6 hours)
- **Mode**: `HAPPIER_STACK_SWIFTBAR_GIT_MODE=cached|live` (default `cached`)
- (Optional) **Background auto-refresh**: `HAPPIER_STACK_SWIFTBAR_GIT_AUTO_REFRESH_SCOPE=main|all|off` (default `main`)

Notes:

- Cached git info can be stale; it’s meant for at-a-glance signal.
- Actions like worktree switching/build/dev are always live (they use `hapsta`); only *displayed git status* is cached.

## Maintenance (selfhost mode)

In **selfhost** mode, the menu includes a **Maintenance** section that can:

- show whether a `hapsta` update is available (from cached `~/.happier-stack/cache/update.json`)
- run:
  - `hapsta self check`
  - `hapsta self update`

## Terminal preference for interactive actions

Many menu actions open a terminal (interactive wizards, long-running dev servers, etc).
The plugin uses helper scripts so these run in your preferred terminal, using the same env var as `wt shell`:

- `HAPPIER_STACK_WT_TERMINAL=auto|ghostty|iterm|terminal|current`

Notes:
- `auto` tries ghostty → iTerm → Terminal → current.
- Ghostty is best-effort; if your Ghostty build can’t execute the command automatically, the command is copied to your clipboard and Ghostty is opened in the repo directory.

## Start SwiftBar at login (optional)

SwiftBar is independent from the Happy Stacks LaunchAgent.

- In SwiftBar Preferences, enable **Launch at Login**, or
- Add SwiftBar to macOS **Login Items**.

## Troubleshooting

### Plugin doesn’t show up

- Ensure SwiftBar is running.
- Check which plugin folder SwiftBar is using:
  - SwiftBar → Preferences → Plugin Folder
- Open the active folder:
  - `hapsta menubar open`

### Daemon shows “auth required” / “no machine”

This happens on a **fresh machine** (or any new stack) when the daemon does not yet have credentials in the
stack-specific CLI home directory.

**What’s going on**

- The daemon stores credentials in `access.key` under the CLI home directory.
- For stacks (including main), that’s typically:
  - `~/.happy/stacks/<name>/cli/access.key`
- When `access.key` is missing, `happy-cli daemon start` enters an interactive auth flow and won’t become a “machine” until it completes.
  - Under `launchd` (autostart), this shows up as **no machine** and the daemon may appear “stopped”.

**If it still needs auth**

- In SwiftBar, open the **Daemon** section:
  - If it shows `auth_required`, click **Auth login (opens browser)**
- Or run manually:

```bash
hapsta auth login
```

### “Daemon stale” even though it’s running

The plugin checks:

- `daemon.state.json` **PID is alive**, and
- (optionally) the daemon control server responds.

If the daemon is running but the menu is stale, refresh and check the **PID** line under “Daemon”.
