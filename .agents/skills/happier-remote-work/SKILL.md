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

The repository command policy chooses the least-loaded healthy configured target from short-lived
cached probes, without a probe-coalescing lock or controller dispatch mutex. It excludes targets whose repository filesystem reports no free space or
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

### Worker disk headroom and lane scratch (0.3 development)

Linux admission observes free bytes on the command's known write filesystems and refuses an
already exhausted filesystem. There is no resident-closure proxy or peer disk reservation;
no operation-specific additional-write peak has been established. Exhaustion triggers ordered
reclamation: old staging across stacks, unneeded Yarn entries, then scratch older than 24 hours.
Unknown UID or same-UID process visibility retains data; processes whose status identifies
only foreign UIDs do not block this user's reclamation. Explicit maintenance applies the same retention policy
independently. AUTO excludes a still-exhausted worker; pins fail with the disk diagnostic.
Status exposes free bytes. Future install/build writes and quotas are not guaranteed by admission.

Lane scripts use a unique `happier-*`, `hstack-*` or `docs-check-*` scratch directory beneath the
worker's temporary directory, for example `mktemp -d "$TMPDIR/happier-lane-disk-budget.XXXXXX"`.
Routed POSIX commands default `TMPDIR` to `tmp` beneath the configured worker CLI home,
on its disk-backed filesystem rather than RAM-backed `/tmp`. Explicit `TMPDIR` is preserved.
Keep scratch outside the source mirror. The existing historical custody reaper covers these names;
24 hours since the newest descendant change and a successful same-UID cwd/fd/mapping check are
required before reclamation. A failed holder query is unknown, never "no holder". If a worker's
unrouted command needs another disk-backed root, `/var/tmp` may be selected explicitly with `TMPDIR`; run the same
reaper against that parent for maintenance. Never relocate or delete a live lane's scratch.

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

### Dedicated QA host (0.3 development)

The canonical QA browser launcher uses `--no-sandbox` under the approved QA-host policy for Happier's own QA app. Attach controller automation to that browser; do not introduce a separate per-lane launch policy. Retain a TTY-backed foreground tool handle and verify cleanup after SIGINT: cancelling a non-TTY checkout launcher can leave the actual command and forward running.

New controlled `--qa`/`agent-qa-*` stacks use the configured linux3, linux2 and linux1 QA pool. `service_placement.mjs` chooses the host with the largest actually available memory budget after live reservations, then writes one explicit daemon pin; command pools never reselect the Machine. Live Expo/browser/daemon RSS is already reflected in available memory, not deducted twice. Include windows1-linux only after its outer Windows C: disk is healthy; it is not a default candidate. Heavy validation stays on hosts fitting its existing class envelopes, independently of this QA pool. Existing stacks change only at an owner-requested next restart, through `dev-targets placement set daemon <target> --stack=<qa-stack>`. This QA default does not change development-daemon placement.

Use `dev-targets qa setup <target> --stack=<qa-stack>` for idempotent managed JS, Claude Code/Codex CLI, Chromium, scratch, power and disk-retention preparation. Never copy user Agent credentials: the paired daemon owns connected-service materialization. Service-memory observation reserves live daemon/browser trees alongside server/Expo trees through the existing admission input; small jobs may use spare capacity and heavy classes retain their canonical envelopes.

For browser QA, `dev-targets browser start <lane-session> --stack=<qa-stack> --url=<qa-ui-url>` selects the QA pool host with the greatest observed unreserved memory for that browser lifetime, independently of the fixed daemon pin, and forwards its CDP endpoint to the controller. Agent-browser/Playwright run locally against the returned endpoint and open the returned browser-facing `url`, which preserves the original origins and canonical Home address. A lane-owned loopback reverse SOCKS route through the existing SSH owner reaches the controller's QA server and borrowed Expo ingress; the browser owner supplies the required proxy policy. Do not rewrite Home URLs or add per-lane launch flags. Preserve the foreground handle; SIGINT retires only its owned browser/profile and forwards. An unusable pool or unavailable selected host fails closed without a controller-local browser; never silently relocate a pinned daemon. Read the controlled-stack skill for the complete QA lifecycle.

For a QA ingress with a self-signed leaf, add `--trust-cert=<controller-local PEM certificate path>` to `browser start`. The controller reads that explicit certificate and sends only its SHA-256 SPKI digest to the worker; Chromium trusts the matching public key for this browser lifetime through `--ignore-certificate-errors-spki-list`. An unreadable or invalid certificate fails the launch. Omitting the option preserves normal certificate checks. Supply only the public certificate, never a private key; certificates are not discovered automatically and system trust stores are not changed.

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
