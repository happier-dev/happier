---
name: happier-remote-work
description: Run user-authorized heavy searches, tests, typechecks, builds, and other development commands on a configured Happier remote dev target backed by the live Mutagen mirror. Use only when the user explicitly asks to use a remote machine, remote dev target, or remote compute for the requested work; never invoke merely because a command is expensive or local resources are constrained.
---

# Happier Remote Work

Remote compute is an execution transport over the repository's canonical Mutagen mirror. Keep the local checkout authoritative for source edits and Git.

## Contract

- Require one explicit user request before using remote compute. That authorization remains active for this user session until revoked or narrowed.
- Continue using the task's normal repository skills; this skill only chooses execution transport.
- Use only the canonical repository wrappers below. Do not add another selector, use ad hoc SSH, or choose an alternate checkout.
- The mirror is continuously moving. Ordinary execution checks synchronization health but does not flush; later local edits may arrive while a command runs.
- Route potentially broad read-only repository work (`rg`, `find`, inventories/counts), tests, typechecks, lint/static analysis, and builds that write only ignored dependencies, caches, bundles, coverage, or test artifacts. Keep tiny targeted reads local when transport would dominate. Never edit or generate tracked source, run formatters/autofixers/codemods, mutate Git, touch databases/Stack lifecycle/devices/simulators, or use unowned local secrets remotely.
- Never weaken host-key checking or put passwords in argv, chat, or environment. Provisioning may prompt in the user's terminal.

## Ordinary automatic execution

Ordinary workspace scripts route automatically through the checkout-local launcher:

```bash
corepack yarn -s typecheck
corepack yarn --cwd apps/server -s test:unit
corepack yarn --cwd packages/plugins/claude -s typecheck
corepack yarn --cwd apps/ui -s vitest run <file>
```

Never invoke a `*:local` script directly; it is the launcher implementation target.

For a suitable read-only or ignored-output command without a public entry point:

```bash
./apps/stack/bin/hstack-exec -- <command> [args...]
```

Run that path from the checkout root. On POSIX, the no-target path replaces itself with the
requested command without starting Node, Yarn, Mutagen, SSH, or a load probe. Node validates target
configuration and refreshes a private shell-safe projection only after configuration changes;
steady-state sync checks, cached load probes, selection, SSH execution, cancellation, and fallback
are native shell operations. `--script` starts Yarn only on the selected host. Windows executes
locally for this POSIX-only routing feature.

The repository command policy chooses the least-loaded healthy configured target from short-lived,
coalesced cached probes. It excludes targets that cannot launch the requested top-level executable
and adjusts cached load for commands dispatched there but not yet reflected by the next probe. Pass
the executable directly when practical; `sh -lc` hides inner tool requirements from this preflight.
Local load participation and local fallback are independent settings. A running Stack is not
required when independent synchronization is healthy. With no usable remote, the launcher follows
the configured fallback. A selected host that cannot establish its command connection is excluded
and the launcher tries another configured target before fallback. A command that actually starts is
authoritative and is never replayed elsewhere after failure.

Use `./apps/stack/bin/hstack-exec --local -- <command> [args...]` when one invocation must remain local. For tiny checks, this avoids transport cost without leaking a local-only policy into later descendant commands.

Configure automatic routing once:

```bash
node ./apps/stack/scripts/repo_local.mjs dev-targets placement set commands auto --targets=mac,mac2 --fallback=local
```

Add `--include-local` to let the local host compete by load. Positive probes default to 15 seconds and unavailable results to 2 minutes.

Keep the mirror available across Stack restarts when requested:

```bash
node ./apps/stack/scripts/repo_local.mjs dev-targets sync-service start --detached
node ./apps/stack/scripts/repo_local.mjs dev-targets sync-service status
```

Use `sync-service start` without `--detached` to see live Mutagen activity. Stack automatically
borrows the all-configured-target independent project without taking over its lifecycle, even when
only a subset of targets runs commands or services. Start resumes and checks every configured
mirror without installing dependencies or building outputs. Command/service preflight owns tool and
dependency readiness. Windows remains sync-only for the native automatic launcher. Stop the service
only when the user asks with `dev-targets sync-service stop`.

## Exact-target execution and barriers

Use explicit transport only for required platform evidence, target-specific cwd/env/TTY, or a synchronization barrier:

```bash
node ./apps/stack/scripts/repo_local.mjs dev-targets exec <target> [--cwd=<repo-relative-path>] [--env=KEY=VALUE]... [--flush] [--tty] -- <command> [args...]
```

- Keep `--cwd` repository-relative and forward environment explicitly.
- Use `--tty` only when genuinely interactive.
- Inspect `node ./apps/stack/scripts/repo_local.mjs dev-targets status <target>` before exact-target work; use `doctor` for SSH, Mutagen, Node.js, or Corepack diagnosis.
- Use `node ./apps/stack/scripts/repo_local.mjs dev-targets sync <target>` or `--flush` only for a point-in-time pre-launch barrier. A flush is not a snapshot and does not prevent later edits.
- If sync is missing, paused, or unhealthy, do not execute against stale bytes. Automatic routing excludes that target; exact-target execution fails with a diagnostic.

## Stack service placement

Service placement uses the same target configuration but has its own lifecycle owner:

- a host/tool preflight failure before a Stack generation starts selects local fallback for that generation;
- a remote child-process failure after dispatch is a service failure, not proof that the host is unreachable;
- in particular, an Expo/Metro crash restarts on its configured target and must not cause a local Expo duplicate;
- the local port remains stable through an SSH tunnel, so browsers, dev clients, and local tools continue using the same URL;
- local source remains authoritative and Mutagen remains local even when watch/build/restart work runs on the target;
- a remotely placed SQLite server uses target-local persistence. Keep the server local until its database is deliberately moved, or select a network database such as PostgreSQL.

Independent commands may run concurrently, but preserve the repository's existing exclusive owners for package state, generated outputs, databases, ports, and devices. Do not add an agent-side global queue.

## Provisioning and recovery

When no suitable target exists, report that fact. If the user asks to configure one, use:

```bash
node ./apps/stack/scripts/repo_local.mjs dev-targets add <name> \
  --host=<host> \
  --user=<user> \
  --repo-dir=<absolute-remote-repo-dir> \
  --cli-home-dir=<absolute-remote-cli-home-dir>
```

The command owns its dedicated key, target-specific `known_hosts`, strict verification, login-shell/toolchain discovery, and registration. The user may enter the remote password directly in their terminal. Never delete target SSH state merely to retry.

## Handoff evidence

Report:

- the selected target (or local fallback), remote cwd/command, and whether a flush was used;
- pass/fail/exit status and any skipped checks;
- whether the command ran against a continuously moving mirror or a deliberately stable integration boundary;
- target/synchronization failures and any clearly labeled local pre-dispatch fallback;
- any platform-specific claim that remains unverified on another platform.
