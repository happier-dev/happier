# Testing

This document records the repository-level test lane map and placement conventions. For workflow details, use the repo skill `.agents/skills/happier-testing` and the development guide at `apps/docs/content/docs/development/testing.mdx`.

## Top-level lanes

Canonical lanes:

- `yarn test` — fast unit lane across apps.
- `yarn test:import-cycles` — CLI runtime import-cycle guard, also enforced by the CLI unit lane.
- `yarn test:integration` — orchestration-heavy app integration lane.
- `yarn test:e2e:core:fast` — default local core e2e loop.
- `yarn test:e2e:core:slow` — long orchestration core e2e.
- `yarn test:e2e:ui` — Playwright UI/browser e2e exercising real UI + server + CLI/daemon flows.
- `yarn test:agents` — executable Agent runtime contracts; opt-in/flag-driven. The historical script name is retained for runner compatibility and does not refer to first-class model Providers.
- `yarn test:db-contract:docker` — server DB contract via Docker.
- `yarn test:plugin-platform:source` — current-source Plugin Platform owner contracts and public-only external-author/runtime fixtures. It never packs or installs an SDK, UI, CLI, or plugin archive.

Use the smallest relevant subset during RED/GREEN loops. Before handoff, run the touched package typecheck/build-enforcing lane and at least one broader relevant lane when shared contracts are touched.

In 0.3 development, `yarn workspace @happier-dev/cli test:unit src/api/artifacts/accountArtifactStore.test.ts` forwards the file selection through the routed script chain and runs it once. Explicit runner arguments, including file and test-name filters, bypass automatic sharding and the unit lane's unrelated native checks. An unfiltered unit run retains its shard/CI-part selection, native script tests and import-cycle guard. Known CLI unit aliases use source-test preparation and the validation class; actual compiler and runtime preparation keeps its own class.

## Choose checks by the changed contract

### Primary workload standby preparation (0.3 development)

`host.mjs` owns `hstack dev-vm primary status` and
`hstack dev-vm primary switch TARGET --dry-run`. The inspection projects the
existing execution-host profile and canonical dev-target configuration through
`utils/execution_host/primary.mjs`; it writes no primary registry or assignment.
An active Mac profile reads the mounted guest configuration through the existing
workspace-mount owner and refuses to substitute the Mac copy when that view is
unavailable. Server placement is a separate fact, never whole-workload authority.
Unknown standby lag and database replica time remain explicitly unverified.

`primary sync TARGET --source=SOURCE --home=HOME` extends the existing
`dev_targets/sync_project.mjs` owner and shared Mutagen daemon/lock. Portable
home state uses one-way-safe synchronization; generated online SQLite backups
use a non-overlapping one-way-replica session in the same project. Raw Agent
SQLite/WAL, ephemeral homes, build outputs, host-local daemon settings and
incoming SSH authorized keys are excluded. Capture does not install snapshots
over a running target's provider databases. The owner source loop is
`.project/plans/2026-09-28-systemic-deep-audit/scripts/primary-switch/owner.test.mjs`;
it exercises real Python SQLite online backup with a committed WAL writer and
the real sync owner through OS/process boundaries.

Non-dry-run switches fail before any transport or state change, even with
`--force`. SSH primary delegation, both stacks' database replication, writer
quiescence, role movement, and restore-test execution remain unimplemented. Do not
use worker-source sync readiness as proof of complete standby freshness: worker
mirrors exclude Git metadata and do not snapshot Agent SQLite databases.
The composed completion check must switch between two lane-owned throwaway
targets, preserve dirty/untracked work, move sessions through canonical handoff
between distinct Machine identities, keep the source daemon accepting new work, restore both stacks' databases
and boot its server, resume Claude Code and Codex sessions, then run the dry-run
against the real topology. It must not switch the owner's current primary.
The real work-session authority currently lives in the read-only 0.2 sibling;
its public handoff and current permission-mode/machine projection gaps require
owner authorization before the composed switch can be implemented. See the
[operator guide](../apps/docs/content/docs/hstack/dev-vm.mdx#move-the-primary).

| Change | Focused loop | Integration boundary |
| --- | --- | --- |
| Package behavior | Existing owner test through real internal logic | Package typecheck and the affected unit/integration lane |
| Shared schema, catalog, or testkit | Shared owner tests plus an affected consumer | Relevant consumer lanes; producer-only green is insufficient |
| UI flow, layout mode, or selector | Relevant component test | Existing Playwright scenario with explicit viewport, mode, and permissions |
| Process, port, daemon, or session lifecycle | Existing process/testkit test | Owning integration lane; ephemeral ports and observed readiness, not fixed sleeps |
| CI selection, sharding, or root commands | Workflow/runner contracts and selected-file inventory | Prove complete, non-overlapping coverage and a failing final result when any required check fails |
| Installer, packaging, or release control | Canonical source contracts | Candidate-dependent smoke/update and publication checks after the actual artifact exists |

Use shared boundary fixtures and real internal owners. A changed internal export is not a reason to expand a local mock; inventory its callers and update the owning fixture once. Assert stable outcomes rather than old implementation spelling. Remove redundant or obsolete assertions only after identifying the behavior they formerly protected.

Root unit and integration commands collect failures across independent workspaces instead of stopping at the first red package. Package preparation remains a prerequisite; aggregate failure collection cannot expose behavior behind an unavailable build, database, or candidate. Do not call an unexecuted lane successful.

In 0.3 development, runtime worker bootstrap, validation preparation, local `hstack` bundled-workspace preflight and the Stack unit runner prepare emitted workspace prerequisites in `source-dev` mode by default. Their package compilers use the existing `package-dist` envelope, reusing an authenticated parent admission when present. Explicit strict mode, typecheck preparation and public packing/publication still check semantics; public `typecheck` remains independent. Both UI patch stages request patch-package's `--error-on-fail`, so a mixed previously patched tree reaches the existing dependency owner's pristine re-extraction and retry rather than being admitted as ready.

Package-artifact publication admits its selected plugin compiler outputs through the existing
workspace dependency build owner before the generator consumes them. This also prepares missing
`dist` on a cold AUTO replica; check-only projections and compiler-input generation do not compile
plugin packages. Existing optional-build isolation and required-plugin failure policy still apply.

Both `source-dev` and `qa-runtime` package builds compile captured inputs, so edits during compilation do not require a quiet checkout. The output record identifies the captured inputs; later edits demand a subsequent build rather than being marked current by the completed build. Strict builds retain their live-input drift fence.

The Stack unit runner isolates product state and caches without dropping its executor placement or authenticated admission identity. Tests simulating a different worker isolate that worker's OS admission state and package-manager executable paths through the canonical boundary fixtures instead of sharing the real host's reservations.

Remote dependency bootstrap reuses the existing per-install dependency refresh lock and checks freshness again after waiting, so same-input callers share the completed installation. In 0.3 development, both remote command entry points finish dependency and workspace preparation before reserving the payload's heavyweight admission envelope. Preparation's compiler leaves retain their own admission. This order lets a dependency/build lock holder obtain admission while another command waits for that lock. Dependency waiters remain behind a live installer without an acquisition deadline; a delayed JavaScript heartbeat during synchronous package-manager work does not permit replacing that owner. The existing lock owner still reclaims exited installers and stale malformed lock records. Native admission decisions reclaim dead owners and owner directories with an unreadable or incomplete process identity under the existing capacity lock; read-only memory samples do not mutate those records.

Routed POSIX commands default `TMPDIR` to `tmp` beneath the configured worker CLI home, on the worker's disk-backed filesystem. Explicit `TMPDIR` remains supported; existing live scratch is never relocated. This prevents default test/build scratch from consuming RAM-backed `/tmp` quotas. Custody owns that environment before admission, preparation and payload execution.

For broad local collection, inspect `node scripts/pipeline/run.mjs checks --profile fast --dry-run` first. For a focused rerun, use a workspace command or `checks --profile custom --custom-checks integration,typecheck --install-deps false`. Custom selection is exact, not an implicit full baseline. The checks owner collects independent failures and returns nonzero; install failure still stops dependent checks.

Local and hosted profiles share selection policy ownership in `scripts/pipeline/checks/lib/checks-profile.mjs`, but are not interchangeable matrices: local profiles preserve local toolchain coverage; hosted profiles include platform/runner jobs. Read the current command help or workflow inputs instead of assuming a local `fast` result certifies hosted `release` coverage. In 0.3, route these commands through `hstack-exec`; its public test scripts already do so.

In 0.3 development, a direct `hstack-exec` invocation from a configured Mac workspace delegates to its active primary execution host through the existing execution-host bridge. The authoritative host's native dispatcher then selects a worker using its own current configuration. Package working directories, launcher flags, explicit environment arguments and exit results survive that handoff. Explicit `--local`, already-placed children, CI and sandbox invocations retain their local paths; candidate profiles do not activate delegation.

In current 0.3 development, active execution-host delegation retains a running guest when only capacity or toolchain updates are pending. It warns with the pending update instead of requiring provisioning or a VM restart before Stack control and command execution, including 0.2 commands using the 0.3 controller. Each guest command still enforces its own tool requirements. Doctor continues to report full provisioning compliance; candidate execution, unavailable guest session management, creation identity drift and security configuration drift remain blocking. The existing known legacy Lima service-forward cutover exception remains transport-specific. Delegation does not apply updates or restart the guest.

The development launcher also accepts `--repo=/absolute/sibling/checkout` before its other options. That checkout has a separate command placement policy and mirror on the configured `mac2-linux`/`windows2-linux` subset by default; change the subset through `dev-targets placement set commands ... --repo=...`. Its Mutagen project uses the same ignore policy and `no-watch` at both ends for command-only targets. Explicit service placements from the sibling's own Stack configuration retain their exact endpoints in that same producer-owned project, with source watching for service targets; `mac-host` remains excluded from automatic command placement. The project seeds each new session once, then crosses the existing selected-target synchronization barrier on dispatch. Admission, AUTO retries, custody and dependency freshness remain 0.3-owned; installation and UI postinstall consume the sibling's own lockfile and source, and dependency builds use its existing workspace owner. From 0.2, the optional thin `apps/stack/bin/hstack-exec` delegates when its executable 0.3 sibling exists. Without that sibling, or with `HAPPIER_ROUTED_EXECUTOR=0`, it executes locally with native stdio, exit and signal behavior. Ordinary 0.2 package scripts are not automatically rewritten; invoke them through the wrapper.

Development command placement uses the native `apps/stack/bin/hstack-exec` owner, including POSIX commands launched through `dev-targets exec auto`. CPU load and used/available memory rank reachable targets. `remote_commands.mjs` owns both workload classification and memory envelopes; its generated `native_command_policy.sh` is consumed by selection, Linux/WSL admission, and explicit local execution. Measured package dist peaks fit the existing 6 GiB `package-dist` envelope: cli-common and Protocol's earlier Linux dist peaks were 1,853,332 and 4,682,608 KiB respectively. Canonical runtime worker requests use `runtime-build` with an 18 GiB envelope: a successful full daemon build on Linux x64 peaked at 16,442,992 KiB of aggregate process-tree RSS. Adding the measured package envelope's 1,608,848 KiB of spare headroom and rounding up to whole GiB gives 18 GiB. Two sequential public TS7 app checks on Linux ARM64 on 2026-10-09 observed largest process-tree metrics of 18,909,772 KiB for UI, 13,688,852 KiB for CLI and 14,179,616 KiB for server. Adding that same headroom and rounding up gives `compilation-ui` 20 GiB, `compilation-cli` 15 GiB and `compilation-server` 16 GiB. The owner decision applies those observations despite incomplete import graphs; they are not certified maxima and must be re-derived if a clean graph measures higher. Unscoped/mixed-package checks and unmeasured builds use the UI-sized 20 GiB `compilation` envelope; serial projects within one package retain its package class. Admission diagnostics and compiler OOMs expose insufficient headroom. Focused validation and dependency installation retain their existing 6 GiB envelope, derived from the earlier approximately 5.3 GB compiler and 1.1 GB suite footprints.

Successful public typecheck measurements on Linux x64 on 2026-10-09 peaked at
10,420,624 KiB of aggregate live-tree VmHWM for Protocol and 2,777,992 KiB for
cli-common. Adding the same 1,608,848 KiB headroom gives minimum rounded
envelopes of 12 and 5 GiB. Their public scripts and compiler invocations reuse
the existing fitting classes: `runtime-build` (18 GiB) for Protocol and
`package-dist` (6 GiB) for cli-common. Plugin SDK also uses `package-dist`:
both public compiler programs ran, peaking at 4,428,896 KiB, and reported
eight TS2322 diagnostics rather than missing dependencies. Docs `types:check`
and its compiler also use `package-dist`; two runs with fresh incremental-state
files peaked at 439,544 KiB. Mixed-package and unknown checks retain
`compilation`. Dependency preparation still admits its own compiler workloads.
Canonical per-package `buildTypeScriptPackageDist.mjs -p tsconfig.json` strict
builds reuse `package-dist`; Protocol and SDK use `runtime-build` because their
public-check observations plus headroom exceed 6 GiB. Emit-only builds retain
`package-dist`. Root and cross-package project builds retain `compilation`.

Development SSH commands, probes and native execution share the OpenSSH control socket selected by the synchronization owner's generated configuration (`sync_project.mjs#prepareDevTargetOpenSsh`). Generated defaults use `ControlMaster auto` and ten idle minutes of persistence; explicit guest socket paths remain in place. The native launcher's existing master-creation lock waits for its live creator instead of opening a new connection on contention. Stack and browser forwards remain dedicated because their owner must remove its listeners on stop without killing another session's master. Enrollment and controller-key verification use independent handshakes rather than treating an already-authenticated master as proof of the configured key. The opt-in Linux host policies and their removal are documented in `apps/docs/content/docs/hstack/dev-targets.mdx`; neither enrollment nor ordinary dispatch applies them.

In 0.3 development, `provision.mjs` owns first-contact enrollment and explicit Linux host
preparation. Enrollment accepts missing Node/Corepack and prints the exact
`host prepare NAME --toolchain` next step; commands still need that toolchain. Explicit
`--toolchain` consumes the Ubuntu worker provision profile's NodeSource Node 24, Corepack,
pinned Yarn, Go and ripgrep setup. It verifies these tools and skips installation when they
are already usable. `--create-user=NAME [--home=/absolute/path]` installs the dedicated public key, enables
general passwordless sudo for the account, and switches the existing target's SSH user. The
default home is `/home/NAME`; `--create-user=leeroy.guest --home=/home/leeroy.guest` provides path
parity. This account policy is distinct from the existing narrow power/browser sudo grants.
Its sudoers filename uses the hex-encoded account name without dots, and the candidate connection
must pass both master-free key login and `sudo -n true` before the target changes. Existing accounts
with another home are refused, as are existing UID-zero aliases and requested homes used by another
account (including canonical path aliases), before SSH keys change. Default mirror/CLI-home paths
follow the new home, explicit paths remain.
CLI Vitest commands declare Go in the shared command policy, and executable preflight checks
that declaration before dependency bootstrap or payload dispatch. Repair a missing Go executable
with the same `host prepare NAME --toolchain` command; no pool-entry removal is needed.
`--tailscale [--tailscale-authkey-stdin]` installs from the official package repository, joins
when needed, and changes the existing target's endpoint to its tailnet address; the auth key
travels only through stdin. `--auto-updates` enables unattended security upgrades without
automatic reboot on Ubuntu. The [worker guide's fresh-host recipe](../apps/docs/content/docs/hstack/dev-targets.mdx#bring-up-a-fresh-linux-server)
then invokes the existing QA tooling owner and exact-target executor before selecting placement.

For existing workers with only the older narrow sudo grant, explicitly refresh it with
`hstack dev-targets host prepare NAME --passwordless-sudo --passwordless-provisioning`
before `hstack dev-targets qa setup NAME`. The browser installer uses
`env COREPACK_ENABLE_PROJECT_SPEC=0` inside sudo to bypass the checkout's Yarn `packageManager`;
the grant permits that exact assignment, not arbitrary elevated environment variables.
QA setup does not broaden privileges automatically; full `--create-user` grants need no refresh.

`--lockdown[=tailscale-only|ssh-public]` owns UFW default-deny incoming policy and SSH password,
keyboard-interactive, and password-based root-login restrictions. Tailscale-only is the default
and ssh-public additionally permits public 22/tcp. Both require installed UFW, Tailscale up,
and an actual fresh tailnet-addressed key connection. The same SSH policy owner adopts the earlier
`40-happier-no-password.conf` beside its fleet SSH configuration. Before every SSH-server/firewall policy mutation,
preparation requires a dedicated-key probe with `ControlMaster=no` and `ControlPath=none`,
arms five-minute automatic rollback, validates SSH configuration, and cancels rollback only
after a fresh post-change key login. A password-authenticated master is not key evidence.
The observed empty `authorized_keys` was caused by the orchestrator's `SSH_ASKPASS` helper:
its inner SSH command consumed the outer command's stdin; adding `ssh -n` fixed that input loss.
The enrollment defect was separately allowing a password-authenticated master to satisfy its
dedicated-key probe. Recovery restores the key through password enrollment or an independent administrator
or provider console, then proves a master-free key login before applying restrictions.

Validate missing-toolchain enrollment, check-first repeated preparation, account/home
changes, secret transport, Tailscale-only refusal, independent key probes and rollback
arming/cancellation. Live proof uses the enrolled host: verify key-only tailnet login, public
22/tcp closure from a non-tailnet path when available (otherwise label UFW/listening-socket
evidence as the narrower observation), run QA setup and exact-target execution, then use existing
command and QA placement owners. Script generation and green unit tests alone do not establish
live host readiness. These host changes are opt-in, never ordinary dispatch side effects.
Ordinary unmanaged `add --host` does not apply power policy; explicit `--managed-lima` and
`--managed-wsl` enrollment still provisions the whole guest and its existing power policy.
`service_placement.mjs#DEFAULT_QA_TARGET_NAMES` orders the default browser pool and new QA creation
projection consumed by `stack_commands.mjs` as `nl1`, `nl2`, `linux3`, `linux2`, `linux1`.
Explicit candidate pools stay exact;
creation defaults never retrofit existing Machine pins. Browser placement ranks the pool for its
own lifetime and does not move the daemon. The implicit browser pool includes only candidates
registered in that consumer's existing target registry, so registries predating either worker still work.
An empty implicit pool and an unknown explicitly named target fail without local browser fallback.

On the Linux controller, explicit `--local` heavyweight compilation (including package-dist and runtime-build) refuses by default and points to AUTO. A caller can explicitly authorize `--local --allow-local-compilation`; this changes placement only and retains class admission plus the existing 8 GiB local floor, even under CI. Already-placed workers do not require the controller override. Light local commands remain immediate. Ordinary automatic CI execution retains its existing exemption.

Selection excludes machines whose total RAM is below the selected class's requirement. Linux/WSL admission subtracts only each live admitted job's unused reservation, `max(0, class envelope - authenticated process-tree memory)`, from available memory: resident pages are already absent from `MemAvailable`. Missing memory observation retains the full reservation. There is no additional guessed available-memory percentage, PSI or CPU-load denial. Reservations remain until exit or proven-dead owner reclamation; authenticated descendants reuse their parent's reservation, and escalation replaces that owner's envelope under the admission lock while crediting its existing resident memory. Explicit `--local` bypasses remote placement and uses this same admission against local memory. Light local commands remain immediate. Diagnostics name available, required and unused reserved memory. The envelopes reserve admission headroom but do not cap a command's actual memory use. Runtime publication placement uses the retained-demand broker described below; busy admission keeps the build remote, and only unavailable capable workers permit configured local fallback. Darwin selection applies the total-capacity filter and load ranking; its existing execution path has no admission queue. Native Windows command routing remains local.

In current 0.3 development source, the canonical Linux observer uses `/proc/<pid>/smaps_rollup` PSS for service/browser and admitted trees so shared pages contribute each process's share. During native admission, it can use the summed service RSS upper bound only when that bound cannot constrain available memory or the class's physical capacity; admitted-owner credits always retain exact PSS. Process metadata is observed once for the executing account, and kernel generations are read without per-PID subprocesses. Vanished processes contribute zero rather than stale RSS; unreadable or malformed PSS for a live process falls back to RSS and reports the accounted fallback PIDs. When neither observation is available, admission retains the full reservation. Historical RSS peak measurements above remain measurements of the original runs.

In current 0.3 development source, the Linux worker fixes admission state at `/tmp/happier-heavyweight-admission-v1` and derives machine identity from the OS. Caller roots, homes, temporary mirrors and target aliases cannot create separate queues. The configured worker execution account owns that directory; unavailable or foreign-account state fails closed rather than falling back to a private root. Existing private-root live owners are observed during cutover, and authenticated legacy ancestors migrate their existing envelope on reentry. Already-loaded older launchers must drain before the new single-queue contract covers every writer.

If remote admission cannot register its state before payload execution, the admission owner emits an execution-qualified failure. Automatic placement excludes that worker for the existing unavailable-probe TTL and tries another configured target; an explicitly pinned invocation reports the failure without changing hosts. Preparation failures and a started payload's exit status, including 75, are authoritative and never request replay.

In current 0.3 development, AUTO checks actual worker admission without waiting after preparation and before payload execution. An execution-qualified busy result releases that dispatch reservation and re-evaluates the remaining pool without an unavailable-host TTL. If every usable worker is busy, the selector waits using the admission pressure-retry cadence and re-evaluates the pool; it does not fall back locally merely because workers are busy. Explicit pins retain the worker's observable admission wait. Existing already-loaded launchers are not restarted or moved by this source change.

POSIX compilation-class dispatch in 0.3 development keeps project locality at this same
AUTO selector. A repeated project scope prefers its most recently completed worker
when the current sample can admit immediately; busy admission falls back to
ordinary pool selection. Each invocation completes its own causal synchronization
barrier and runs through the existing heavyweight admission. The native compiler
remains authoritative for incremental currentness. There is no input-equality
scan, shared in-flight result or completed-check cache.

Remote development service readiness and QA-browser forward readiness have no
automatic overall startup deadline. They follow their owning process/user
cancellation and exit lifecycle; positive explicit service-readiness options
remain operator choices. Mutagen project mutation still uses its canonical
exclusive lock, without a competing acquisition deadline. Remote cancellation
confirmation similarly has no separate ten-second command cutoff.

In current 0.3 development source, browser workers retain their signal handlers until their detached agent-browser session and temporary profile are closed. Controller loss follows the existing stdin lifeline; browser custody sends `close` through the existing control channel and awaits that cleanup rather than applying the generic two-second group cancellation. Stack stop retires exact Stack-name/env-file/browser-kind bindings locally and on configured POSIX targets, even without runtime state. It closes workers before sweeping remaining orphaned browser processes. An unavailable target leaves browser retirement unconfirmed, reports `browser_cleanup_unconfirmed:<target>`, and allows stop to proceed. A reachable target reporting browser cleanup failure still prevents finalization. This does not authorize another Stack's processes or a controller-local fallback.

Remote Stack retirement in current 0.3 development uses the canonical trusted-process lifecycle owner when a runtime record survives a reboot; a retained file does not prove its recorded processes are alive. The existing legacy Expo-state probe still blocks retirement while a recorded Expo process survives. After a failed or interrupted stop, including one with no exit status, a fresh absence probe can confirm retirement. Surviving processes or unreadable membership remain unconfirmed and block completion.

Runtime builds prepare and upload captured source before creating a native runtime-build owner or waiter. Source-transfer PREPARE/ACK precedes, and does not replace, actual admission READY. Once source is ready, builds retain one original worker demand while native AUTO checks alternatives on that same cadence. Each alternative refreshes command capability, synchronization and load rather than reusing unavailable or load caches. A selected alternative still flushing does not stop checks of other workers; its channel stays alive and its worker is excluded from concurrent selection until actual admission or failure. Only actual READY releases the original demand. Daemon builds prefer eligible native OS/architecture workers over supported cross builders; server/web placement keeps load-based ranking. Busy native workers still allow later cross-builder admission.

Every native admission resource check reclaims owner and waiter records whose process generation is proven dead, including pressure-denied readiness probes and inherited escalation. Live records remain queued; reclamation adds no age deadline and never signals a process.

Linux worker disk admission uses `worker_disk_budget.mjs` to observe free bytes on
the command's known write filesystems. It refuses an already exhausted filesystem;
resident dependencies, caches and retained outputs do not establish additional writes,
so there is no disk-envelope reservation or guessed build peak. Exhaustion triggers
ordered custody reclamation (oldest stale staging across stacks, unneeded Yarn entries,
stale lane scratch). Explicit maintenance can run that retention policy independently.
A still-exhausted worker is excluded before bootstrap/payload; pins report the disk
diagnostic. The execution-qualified disk marker never authorizes replay of a started
command. `dev-targets status` exposes free bytes. Admission does not guarantee capacity
for future writes or filesystem quotas; real write failures remain authoritative.

Linux/WSL waiting messages and `dev-targets status NAME` expose authenticated admission holders' class, PID, process age, phase and approximate recent process-tree CPU use. Newly created native owners start at `admitted`; a runtime worker reports `awaiting-runtime-request` before its build ACK and `building-runtime` after it. The awaiting phase includes producer publication-flight waits after actual admission; `building-runtime` does not imply CPU activity or rule out internal lock waits. Phase is diagnostic only and never changes the reservation. Older loaded owners without the optional field report unknown; their record lifecycle is unchanged. The existing service-memory observer owns this read-only projection. Waiters reuse their preceding cadence sample; status takes a second sample at that cadence when holders exist. CPU counters have one-second resolution, unavailable evidence is reported as unknown, and zero recent CPU is not a hung verdict. Observation never imposes a holder deadline or kills work.

An explicit routed `hstack-exec --heavyweight-admission --class=... -- ...` carries its class into this same placement policy before committing to a worker. Payload flags after the delimiter do not change the envelope. Native memory observation uses the existing native process-identity owner without installed workspace dependencies, so fresh mirrors can enter admission before their first dependency bootstrap.

Stack unit roots, CLI default test homes/bins, external-hook configuration fixtures and docs-check fixtures use `scripts/testing/process/temporaryDirectories.mjs` for normal teardown. On Linux, the existing remote execution custody owner can reclaim newly marked roots after their creator, process group and explicitly bound descendants are gone. Detached children inherit `HAPPIER_TEST_TEMP_ROOTS`; inaccessible ownership observations retain the root. In current 0.3 development, its explicit `reap-temp-roots` maintenance mode also checks historical `happier-*`, `hstack-*` and `docs-check-*` directories beneath the worker's temporary directory. Linux runtime-build requests invoke the same historical scanner before compiling; ordinary command dispatch already reaps marked abandoned roots. It reclaims only account-owned, non-symlink roots whose newest descendant mtime is older than 24 hours and which no live same-UID process uses as cwd, open descriptor or mapped file. Unknown UID or same-UID visibility retains candidates; processes whose status identifies only foreign UIDs do not block this user's reclamation. The 24-hour margin is based on builds of at most three hours and watchers of at most two hours, and does not limit admission waits. Reclamation logs paths and allocated bytes, counting hard-linked files once. Invoke the mode through target-specific execution of `bash apps/stack/scripts/utils/dev_targets/remote_execution_custody.sh reap-temp-roots - historical-sweep`; it never signals processes.

Service placements do not exclude command hosts. Admission measures resident memory of current server/Expo process trees through their existing Stack PID state and process-generation witnesses, including standalone Expo state. It limits capacity to total RAM minus that resident memory without subtracting RSS twice from `MemAvailable`. Active builds retain their `runtime-build` class reservation. Diagnostics expose service and command reservations; no second placement list exists. A class larger than total RAM minus service reservations fails immediately with a remote-routing instruction, rather than waiting for impossible local capacity.

Fitting work can backfill a blocked queue head. There is no existing admission deadline: cumulative backfill is instead bounded by that head's existing class envelope, and stops when a candidate envelope would bridge its capacity gap. Successful admissions alone consume this allowance; failed attempts and readiness probes do not. This prevents an endless stream of small commands from starving the head, without adding a timeout or fixed job-count ceiling. Admission cannot make unavailable physical capacity appear.

Capacity exclusions are invocation-specific: healthy raw samples remain usable by focused work on smaller workers and retain the default 15-second positive probe TTL. Dependency-refresh waiting belongs to the bootstrap's workspace lock before payload admission, within the same cancellable target execution. A selected sync-flush failure retries another target before any command starts; if reachable targets have synchronization or prerequisite failures, the launcher reports an actionable error. Configured `fallback=local` applies only when no remote target is reachable, with an explicit log. Explicit `includeLocal` participation, local placement and machine-local invocations remain distinct from fallback. Exit 137 remains authoritative and reports possible OOM with the last target memory sample; it is never automatically replayed. Outbound routing requires a cwd inside the synchronized repository; explicitly local publishers and already-placed children may use temporary repositories.

Development fleet workers hosted on Windows use the managed WSL2 backend: `dev-targets add NAME --managed-wsl --outer-ssh=ALIAS --outer-ssh-config-file=PATH --dedicated-cpus=N --dedicated-memory-gib=N` provisions a named Ubuntu 24.04 guest through an authenticated Windows SSH host. The guest remains a POSIX execution target under the existing synchronization, placement and admission owners. Configure automatic placement with the guest name only; the Windows host stays a manual boundary. Capacity is explicit and `.wslconfig` applies to all WSL2 guests for that Windows user. Provisioning requires other WSL workloads stopped; forced capacity changes refuse to stop other running distributions. Guest SSH keys are pinned through the authenticated host, and a Windows startup task keeps the guest running. This backend is development-only. Verify enrollment with `doctor`, `sync`, and a command through `dev-targets exec NAME` before selecting the guest for automatic placement.

Managed guest SSH publication uses the guest alias as its multiplex identity and proxies to the outer host's loopback address. This prevents guests on different hosts with the same SSH port from sharing a connection. Foreground Stack launchers forward interruption and wait for cleanup; explicit `dev-vm exec` and ordinary delegated commands use the same guest scope owner so cancellation cleans up the guest job before closing its host transport.

In 0.3 development, `apps/stack/bin/hstack-dev-target-control` owns the native per-session synchronization barrier for automatic and exact-target commands. Queued requests may share a successful Mutagen flush only when it started after each request captured demand. A request arriving during a flush requires a later cycle, so a just-written source file cannot be admitted against an earlier scan. Each caller checks fresh exact-session health before dispatch; failed or canceled flushes cannot satisfy demand. Platforms without `flock` retain a separate flush and health check for every request.

The 0.3 routing producer owns one Mutagen daemon/data directory for development
mirrors, separate from product workspace synchronization. Each source checkout
has its own project and one session per used target in that daemon; sibling
command configurations do not own daemons. Session identity includes the source
root, so two repositories routed to the same worker have independent causal
barriers. Stack and QA supervisors only borrow existing producer mirrors and
cannot replace their membership or retire them on shutdown. Provisioning and
retirement belong to the routing sync service. A failed resume does not restart
the shared daemon, and project replacement flushes old membership before
termination. Mac mirrors require a current Mac-only flow, not withdrawn
exact-target typechecks alone.

`mutagen_runtime.mjs` owns first-cycle readiness, including its generated `native_sync_readiness.sh` projection. A clean connected idle session with both endpoints in `no-watch` and no completed cycle is `needs-flush`: eligible for selection, with the mandatory dispatch barrier establishing a completed clean cycle before any payload. An active initial scan remains `synchronizing`. Status and doctor read the same classification; startup seeding also consumes it rather than deciding independently from watch/cycle fields.

Managed worker enrollment and automatic command placement attempt to disable sleep through `dev-targets power no-sleep NAME|auto`. Ordinary unmanaged SSH enrollment requires explicit `host prepare --no-sleep` or `power no-sleep`. Managed workers apply the same policy to their outer host and Linux guest. Windows disables AC/battery idle and unattended sleep, idle hibernation and lid-triggered sleep; macOS disables idle system sleep; Linux masks systemd sleep targets. Manual targets are excluded from automatic placement setup. An existing Windows machine policy enforcing zero satisfies that setting; conflicting policy remains an error. Administrator privileges are required, and denied settings are reported without blocking worker enrollment or changing placement. The explicit power command returns failure for incomplete configuration. These defaults belong to worker setup, not ordinary Happier installation on a personal computer.

In 0.3 development, Windows worker setup also installs the machine-wide `Happier-Worker-Power` task under SYSTEM, with boot and logon triggers and no execution deadline. Its administrator-protected script reapplies and verifies the same settings at boot and holds a named system power request. The existing per-user WSL task owns guest startup separately: running WSL alone does not prevent Modern Standby. The request keeps an AC-powered worker active while allowing its display to turn off. Windows limits power requests on battery and honors explicit user sleep; keep an unattended Modern Standby worker on AC. See Microsoft's [Modern Standby software preparation](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby) and [power-request limits](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest).

`dev-targets status NAME` reads power health for the host and guest alongside synchronization and runtime health, including effective Windows machine-policy overrides, the boot task and active power request. An unhealthy or unavailable power observation makes status fail without changing synchronization state. On macOS, incomplete idle-sleep policy reports the one-time host command `sudo pmset -a sleep 0`; Linux health requires all worker sleep targets to remain persistently masked. Power verification belongs to `worker_power.mjs`; status does not apply settings.



In 0.3 development, `apps/stack/scripts/utils/dev_targets/remote_commands.mjs` owns command classification; the native launcher consumes its generated `native_command_policy.sh` projection rather than maintaining another classifier. Native `node --test` commands receive installed-dependency readiness. Only source-proven test commands bypass workspace publication; unknown native commands retain component preparation. Stack dependency-closure publication is reserved for Stack validation, not every remote command. Default CLI/UI Vitest configurations resolve workspace source; default UI tests use the typed empty bundled-app inventory fixture, while `vitest.artifact-cache.config.ts` retains generated inventory and artifact preparation. Workspace build currentness remains owned by the dependency-closure/fingerprint path; there is no separate `prepare:build-inputs` hook.

CLI tests that copy or natively import physical public SDK packages run in `vitest.integration.config.ts`, through the same canonical workspace preparation. This includes public-authoring activation, cross-copy `PluginError`, lone-file SDK resolution, scaffold compiler/UI journeys and prepublication author installs and packs. Current-source catalog and RPC compositions that activate workspace Agent modules use `apps/cli/vitest.source.integration.config.ts`. It reuses the integration lane's resolver, aliases, includes, pool and environment, with source-only setup: native process custody is prepared, while provider declarations come from the tracked manifest projection and activation loads the real development modules. CLI unit setup uses this same source role. Compiled CLI modules, including `dist` in a source checkout, still admit distribution publication failures; packaged and unknown roles retain fail-closed inventory checks. Source imports do not satisfy fixtures that consume copied package trees or prepared CLI subprocess outputs. Temporary filesystem/process fixtures that produce their own inputs remain source-owned.

Run a source integration slice through the canonical wrapper, for example:

```bash
./apps/stack/bin/hstack-exec -- yarn --cwd apps/cli vitest:local run --config vitest.source.integration.config.ts src/api/apiMachine.preflightCatalogs.runtimeCatalog.integration.test.ts
```

The wrapper recognizes this exact CLI source configuration and retains normal validation admission and installed-dependency readiness. Other custom configurations retain workspace preparation.

Collect one complete reachable failure set, fix deterministic clusters locally, then rerun affected lanes. Use one final required hosted profile for the coherent source, not a full graph per test edit. Reuse successful evidence when source, dependencies, configuration, command, and environment remain applicable. New source or a previously unreachable candidate boundary can legitimately expose another failure.

Moving-source feature QA ends at source, integration, and the loaded development
runtime. A package tarball, candidate archive, or immutable release identity is
not an extra feature-completion gate. Exact-package consumer, integrity, and
publication checks run only inside an explicitly authorized release operation
against the bytes that operation may publish.

## Managed Lima networking (0.3 development)

`apps/stack/scripts/utils/managed_lima/profiles.mjs` owns network policy for
both controller and worker VZ guests. New instances include `vzNAT`; retained
instances change only through the explicit `network apply --force` command.
`lifecycle.mjs#applyManagedLimaNetworking` owns stop → network-only edit → start
and native configuration/power readback. The controller command wraps that
owner with its existing SSHFS and service-tunnel teardown/startup. Ordinary
start, recovery, doctor, and resource edits leave retained networks unchanged;
missing native NAT is not a new health failure that blocks existing commands.

The external basis is [Lima's VMNet contract](https://lima-vm.io/docs/config/network/vmnet/)
and the installed v2.0.3/v2.1.0/v2.2.0 source: added networks default to metric 100,
usernet uses 200, and VZ retains its usernet device beside native NAT. The
usernet subnet still carries host/DNS access. The forwarding configuration is
preserved, and Stack service/Mutagen SSH transport keeps its existing owners.
The installed versions pin gvisor-tap-vsock v0.8.7/v0.8.8/v0.8.9, whose TCP forwarder
admits 10 incomplete connection attempts; this is not an established-connection
limit. Incident counts alone do not prove its saturation.

CLI boundary fixtures cover network generation, explicit authorization,
idempotence, route-priority correction, retained configuration, and edit failure.
Live proof requires an owner-scheduled VM restart: record the Lima version and
instance/store, apply once, check the native default route plus usernet's
connected route, resolve DNS/`host.lima.internal`, probe SSH and actual Stack
tunnels, and confirm Mutagen reconnects. Do not restart a VM to satisfy a source
lane's tests. Operator steps and guest Tailscale identity are documented in the
[development VM guide](../apps/docs/content/docs/hstack/dev-vm.mdx) and
[worker guide](../apps/docs/content/docs/hstack/dev-targets.mdx).

`apps/stack/scripts/provision/linux-inotify.mjs` owns the owner-approved
`max_user_instances=1024` policy. Managed guest provisioning invokes it outside
toolchain readiness; Linux/WSL `dev-targets host prepare --inotify` embeds it in
the existing one-sudo preparation session. Neither path changes
`max_user_watches`. OS-boundary fixtures execute the real shell policy against
isolated sysctl/file adapters and assert the persisted file, live value,
repeat behavior, and combined sudo scope. Live boot persistence still requires
the owner's post-restart readback; sysctl.d is a boot input on systemd guests,
not proof that every WSL init loads it. Removal is documented in both guides.

## Voice and audio validation

The current 0.3 development QA seam is [`createVoiceQaController`](../apps/ui/sources/voice/qa/voiceQaController.ts), with default dependencies in [`voiceQaRuntimeDeps.ts`](../apps/ui/sources/voice/qa/voiceQaRuntimeDeps.ts). Text and media start modes are distinct; media delegates to the normal Voice lifecycle owner and binds the exact Home-qualified Session target. [`voiceQaDebugRuntime.ts`](../apps/ui/sources/voice/qa/voiceQaDebugRuntime.ts) defines the development/debug-runtime check. This is a development validation aid, not a second Voice runtime or a release-availability claim.

Choose the evidence boundary before running a canary:

- Text injection tests turn/tool routing and textual results; it does not prove microphone capture, speech recognition, output audio or acoustic interruption.
- A media run must prove that input audio has energy and reaches the selected active transport. A live/enabled track or elapsed microphone time is insufficient. Measure the input and observe the expected transcript/result; capture output evidence separately when claiming audible behavior.
- Browser fixture capture can use Chromium's file-backed fake microphone when the browser supports it. Verify the loaded browser's actual track rather than assuming the launch flag worked. Simulator/emulator loopback tools are environment-specific aids, not substitutes for real device acoustics.
- Exercise permissions, cancellation, interruption, transport loss and terminal cleanup through the normal host owner. Record the actual runtime, platform, account and exact Session binding; a debug route or a text canary alone does not close the normal-UI journey.
- Physical microphone/speaker quality, AEC, Bluetooth routes, native audio focus and background/lock behavior need their named device/release checks. Missing hardware evidence is reported explicitly and does not manufacture another feature-completion gate.

An approved Voice program may require a larger composed journey; use its current execution recipe for that work. Standing evidence rules live here, while program status and past host measurements remain in the program's evidence.

## Test worker budgets

Ordinary Vitest configurations share `scripts/testing/vitestWorkers.ts`: the
default maximum is `max(1, min(4, floor(availableParallelism() / 2)))`, with a
minimum of one. Development and CI use the same default. Vitest otherwise sizes
an invocation from CPU count, not current machine load; several independent
invocations can still contend, so runner-level concurrency also matters.

Set `HAPPIER_VITEST_MAX_WORKERS` to a positive integer for an explicitly sized
local or CI job. CLI worker flags remain available for individual invocations.
The UI-only `VITEST_UI_MAX_FORKS` override remains supported with its existing
six-worker ceiling; the shared override takes precedence. Explicit single-fork,
single-thread and non-parallel lanes retain their stronger isolation contract.
No test selection, assertions or coverage settings change with this budget.

## TypeScript toolchain

The repository deliberately separates the compiler from the programmatic TypeScript API:

- `@typescript/native` provides the TypeScript 7 compiler used by first-party typecheck and package-build lanes.
- `typescript` remains the TypeScript 5.9 API consumed by AST tooling and ecosystem integrations. Do not replace it with TypeScript 7 until the native release provides a stable compatible API and every consumer supports it.
- `scripts/workspaces/resolveTypeScriptCliInvocation.mjs` is the only compiler-selection owner. First-party scripts must use `runTypeScriptCli.mjs`, `buildTypeScriptPackageDist.mjs`, or that resolver directly; do not invoke a bare `tsc` shim or resolve `typescript/bin/tsc`.
- `yarn tsc ...` is defined at the repository root and in every TypeScript-owning workspace; it delegates to the shared native runner and therefore uses TypeScript 7.

CLI and UI typechecks run `tsconfig.source.json` (source) and `tsconfig.test.json`
(tests and their imported source) sequentially through that runner, including
the root source-workspace lane. Both retain the original strictness, aliases
and ambient declarations, with separate incremental caches. The original
`tsconfig.json` remains the shared full-coverage base so existing configs that
extend it retain their coverage. Repeated
`--project` arguments check every project even after compiler diagnostics and
return a nonzero result if any project fails; cancellation or launch failure
stops the sequence. These large app programs explicitly use `--singleThreaded`
to avoid retaining duplicate native checker state. Use the public package
`typecheck` entry point to check both programs, not only the source config.

Ordinary CLI builds also use one native checker. Under the existing CLI
publication lock, `apps/cli/scripts/build.mjs` reuses the source-generation path
and its compiler metadata across dev-watch builds. Each generation replaces all
copied authored inputs and removes them after use; only the incremental cache
survives. Unlocked builds keep private generations. Package dist compilation
uses one checker by default and the existing package-lock-owned compiler cache
in `scripts/workspaces/buildTypeScriptPackageDist.mjs`; an explicit
`--singleThreaded false` compiler argument opts out. Content currentness and
output promotion remain owned by the existing workspace build pipeline.

## Lane naming and placement

- App integration tests: `*.integration.test.*`, `*.integration.spec.*`, `*.real.integration.test.*`.
- Core e2e slow tests: `packages/tests/suites/core-e2e/**/*.slow.e2e.test.ts`.
- Core e2e fast tests: other `packages/tests/suites/core-e2e/**/*.test.ts`.
- UI Playwright e2e: `packages/tests/suites/ui-e2e/**/*.spec.ts`.
- Agent runtime/stress suites remain under `packages/tests/suites/agents` and `packages/tests/suites/stress`.

First-class model Provider coverage follows its owning layer rather than the historical Agent-runner name:

- protocol schemas, settings, migrations, selection, compatibility, and catalog merge: `packages/protocol/src/providers/**/*.test.ts`;
- daemon resolution, probing, discovery, materialization, and lifecycle: `apps/cli/src/providers/**/*.test.ts`;
- Provider UI/settings/model-picker behavior: `apps/ui/sources/providers/**/*.test.ts(x)`;
- built-in Provider facts: `packages/plugins/<providerId>/src/provider/contribution.test.ts`;
- cross-package and real-session behavior: `packages/tests/suites/core-e2e/**` and `packages/tests/suites/ui-e2e/**` with `.feat.providers.` naming where feature gating applies.

Security-sensitive tests must prove fail-closed ordering: a disabled feature, invalid endpoint, absent machine grant, incompatible Agent binding, or missing connection must refuse before secret lookup, network I/O, or process spawn.

Treat `test` and `test:unit` as fast lanes. Put Dockerized dependencies, multiprocess setups, external services, real network calls, or other heavy orchestration into integration/e2e/provider lanes.

When introducing or moving a lane/pattern, update all relevant places in the same change:

1. package-level scripts/config,
2. root `package.json` lane scripts,
3. CI workflow wiring.

## UI e2e authoring

- Prefer stable React Native `testID` selectors, queried in Playwright with `getByTestId(...)`.
- Treat e2e `testID`s as API surface; update specs when renaming/removing them.
- Wait for controls to be enabled before clicking.
- Click the real submit/confirm affordance.
- Do not rely on settings-sensitive shortcuts such as Enter-to-send unless the test explicitly configures that setting.
- UI e2e artifacts live under `packages/tests/.project/logs/e2e/ui-playwright/`.
- UI e2e runtime process logs live under `.project/logs/e2e/*ui-e2e*/`.

## Guardrails

- No `.skip`, `.todo`, `.only`, or hidden conditional skips in committed tests unless an explicit opt-in external probe documents the gate.
- No debugging logs in tests.
- No duplicate test intent.
- Evidence must come from trusted runners, not fabricated/manual output.
- Prefer contract-focused assertions over copy/formatting assertions.
- CLI runtime import cycles are fail-closed: update the baseline only for known debt, and keep `yarn test:import-cycles` wired through the root script and `@happier-dev/cli` unit lane so CI exercises it with CLI tests.
