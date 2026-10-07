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
- The mirror is continuously moving. Ordinary remote execution performs a blocking Mutagen flush before opening the selected target command connection; later source edits may still arrive while a command runs.
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

Use the package's routed `vitest` entry point for a focused Vitest file. Do not
append a file or `-t` filter to a package's aggregate `test` or `test:unit`
script unless that script explicitly documents argument forwarding: compound
aggregate scripts can still launch their complete suite before an appended
filter reaches the final child command.

Only a script whose current `package.json` command invokes `hstack-exec --script=...` routes
automatically. Do not assume that every Yarn script is routed. Before running another broad or
expensive script, inspect its definition; when it does not already invoke the launcher, wrap the
public script explicitly instead of running it bare:

```bash
./apps/stack/bin/hstack-exec -- corepack yarn --cwd apps/docs -s check:content
```

Never invoke a `*:local` script directly; it is the launcher implementation target.
Likewise, do not invoke `typecheck:source:finite` or package `typecheck:finite` tasks directly;
they are nested Turbo implementation targets that assume their public `typecheck` caller already
selected the machine. Use the public `typecheck` script instead.

For a suitable read-only or ignored-output command without a public entry point:

```bash
./apps/stack/bin/hstack-exec -- <command> [args...]
```

Default to these automatic forms whenever the command is eligible for remote execution. Pin
`--target=...` only when the evidence requires a particular platform, host or machine-local state.
Explicit targets retain the same Linux memory, PSI and class-reservation admission as automatic
targets: a busy pinned worker waits and reports its admission reason. A configured service target
such as `mac-host` is eligible for auto placement only when it is also explicitly included in
`commandExecution.targets`.

Do not preemptively add `--local` because a target might be unavailable, synchronization might be slow, or
the caller wants a reliable fallback. Target selection and the configured `fallback=local` policy
own that decision: the launcher tries healthy targets and runs locally when none is usable.

Use `--script=` only for an actual repository package script. Direct tools such as `rg`, `find`,
`node --test`, or a test-runner binary use the `-- <command>` form.

Run that path from the checkout root. On POSIX, the no-target path replaces itself with the
requested command without starting Node, Yarn, Mutagen, SSH, or a load probe. Node validates target
configuration and refreshes a private shell-safe projection only after configuration changes;
steady-state sync checks, cached load probes, selection, SSH execution, cancellation, and fallback
are native shell operations. `--script` starts Yarn only on the selected host. Windows executes
locally for this POSIX-only routing feature.

The repository command policy chooses the least-loaded healthy configured target from short-lived,
coalesced cached probes. It excludes targets whose repository filesystem reports no free space or
that cannot launch the requested top-level executable
and adjusts cached load for commands dispatched there but not yet reflected by the next probe. Pass
the executable directly when practical; `sh -lc` hides inner tool requirements from this preflight.
Local load participation and local fallback are independent settings. A running Stack is not
required when independent synchronization is healthy. With no usable remote, the launcher follows
the configured fallback. A selected host that cannot establish its command connection is excluded
and the launcher tries another configured target before fallback. If Linux admission cannot register
or maintain its state before bootstrap or the payload starts, automatic routing excludes that worker
for the existing unavailable TTL and tries another configured target. An explicitly pinned target
reports the failure without changing hosts. A command that actually starts is authoritative and is
never replayed elsewhere after failure, including when it exits with the admission protocol's status.

In current 0.3 development, AUTO also retries actual worker admission before bootstrap or payload
execution. An execution-qualified busy result re-evaluates the remaining pool without an unavailable
TTL. If every usable worker is busy, it waits and re-evaluates the pool; busy workers do not justify
local fallback. Pins retain their observable worker admission wait. Already-loaded launchers are
not restarted or relocated by a source update.

Use `./apps/stack/bin/hstack-exec --local -- <command> [args...]` only when that invocation must run
on the authoritative local machine even while healthy remote targets are available—for example, it
reads machine-local runtime state or exercises the local launcher itself. Do not use `--local` as a
remote-health workaround or routine optimization; doing so bypasses automatic load spreading and
its local fallback contract.

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

Use explicit transport for required platform evidence or target-specific cwd/env/TTY. It uses the
same mandatory pre-launch synchronization barrier as automatic routing:

```bash
node ./apps/stack/scripts/repo_local.mjs dev-targets exec <target> [--cwd=<repo-relative-path>] [--env=KEY=VALUE]... [--flush] [--tty] -- <command> [args...]
```

- Keep `--cwd` repository-relative and forward environment explicitly.
- Use `--tty` only when genuinely interactive.
- Inspect `node ./apps/stack/scripts/repo_local.mjs dev-targets status <target>` before exact-target work; use `doctor` for SSH, Mutagen, Node.js, or Corepack diagnosis.
- Every exact-target launch flushes once after its healthy-session check. Use `node ./apps/stack/scripts/repo_local.mjs dev-targets sync <target>` when a barrier is needed without launching a command. The legacy `--flush` spelling is accepted but does not add another flush. A flush is not a snapshot and does not prevent later edits.
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
