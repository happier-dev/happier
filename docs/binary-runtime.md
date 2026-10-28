# Binary-Safe Runtime and Bundled Workspaces

Happier ships binary installers. First-party runtime paths must work on machines that do not have system `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx`.

## Runtime contract

In current development source, `scripts/pipeline/release/bun-standalone.entitlements.plist`
owns the macOS hardened-runtime permissions for shipped Bun executables. Standalone
signing consumes it directly. Tauri's base configuration references this file
directly, so stable, preview and dev desktop bundles give the same JIT permission
to the bundled Bun-compiled `hsetup`.
Signature validity and notarization alone do not prove startup: release validation
must inspect the bundled helper's JIT entitlement and execute `hsetup --help` on
the native target without disabling JIT.

Do not introduce direct product-runtime calls to:

- `spawn('node', ...)`
- `npm`, `npx`, `pnpm`, `yarn`, `bunx`
- shell installers from UI/daemon/runtime code
- PATH-only provider detection as the sole source of truth

These are allowed only behind centralized managed runtime/tooling abstractions.

Before adding or changing a provider/runtime/install/update flow, classify it as one of:

- system-first backend CLI
- managed-first internal prerequisite
- managed package
- vendor install recipe
- managed JS-runtime dependent

Provider detection, install status, daemon validation, runtime spawning, and UI/installables must reuse the same source of truth. Backend CLIs should prefer user/system installs by default over Happier-managed installs unless an explicit setting says otherwise.

In current development source, Windows command discovery and invocation share
`packages/cli-common/windowsCommandInvocation.mjs`. A recognized npm wrapper that
only forwards arguments to an existing native `.exe` resolves to that executable,
avoiding `cmd.exe`'s smaller command-line limit (including Claude Code's native npm
installation). Other command scripts retain shell execution and its existing
quoting, including npm JavaScript wrappers and wrappers whose target is missing
or still a text placeholder. Recognition does not choose a different installation
or modify the subprocess environment.

In current development source, vendor installers preserve the Windows process
environment's `Path` spelling; cloning that environment and replacing it with an
empty `PATH` prevents executable resolution. Only POSIX recipes prepend user
install directories. Windows recipes declare `powershell.exe` in the shared
provider catalog, which also supplies the copyable installation guidance.

In current development source, managed Codex archives retain the shared extractor's
path, link, entry-count, checksum, and decompression protections. The provider
catalog allows 384 MiB per file and 512 MiB across all archive files, including
members that are not published into the managed runtime. The digest-verified
Windows x64 `rust-v0.163.0` archive expands to 465,689,987 bytes and therefore
exceeds the previous 384 MiB total. Extraction failures preserve the previous
managed runtime. The shared extractor's `archive-expanded-byte-limit` failure is
carried through install/update responses so the Updates UI can show localized
upgrade guidance while keeping raw diagnostics behind View log.

In current development source, Pi's vendor-managed launcher is a system-install candidate
in the shared provider resolver: `PI_CODING_AGENT_DIR/bin/pi`, then `~/.pi/agent/bin/pi`,
when `PATH` has no matching executable. Explicit `HAPPIER_PI_PATH` remains exclusive and
the existing Happier-managed source preference remains authoritative. Detection, version
probing and launch all consume that resolution; the launcher owns its pinned Pi release.
An unresolved required CLI throws `ProviderCliNotFoundError` at the shared command/launch
boundary. The primary-session classifier preserves it as `dependency_failure` with code
`provider_cli_not_found` and the canonical remediation, without exposing raw paths or
mistaking runner turn allocation for provider prompt acceptance.

In current development source (not yet released), Windows x64 CLI and hstack payloads carry
`happier-service-launcher.exe`, the native task launcher described in
[CLI architecture](cli-architecture.md), beside their executable; the npm CLI and stack packages
carry it under the bundled cli-common package at `native/windows/bin/windows-x64/`. It is a
release-time artifact built from `packages/cli-common/native/windows/service-launcher.cpp` by
`scripts/pipeline/release/build-windows-service-launcher.mjs` in the Windows release job, and the
existing Ubuntu jobs consume that exact build. Installed hosts never compile it, and source
checkouts must run the build script before installing a Windows service. A self-contained binary
resolves the launcher from its runtime root
(`packages/cli-common/src/firstPartyRuntime/resolveSelfContainedCliRuntimeRoot.ts`, the same root
the CLI's `resolveCliRuntimeAssetPath` uses): a `~/.happier/bin/happier|hprev|hdev` shortcut is a
hardlink or copy, so it maps to `~/.happier/<cli root>/current`; any other self-contained binary
uses its own directory. Node and Bun processes use the package asset. Windows hstack has no
supported shortcut installer today, so a binary hstack resolves the launcher beside itself; a
future Windows hstack shortcut must be added to that runtime-root mapping.

## Installer GitHub authentication

In current development source, the standalone Bash and PowerShell installers prefer
`HAPPIER_GITHUB_TOKEN` over `GITHUB_TOKEN`. A token rejected with HTTP 401 triggers
an anonymous retry and a visible warning, including outside verbose mode. Other
failures retain authentication for the existing retry policy. Bash buffers metadata
responses so a failed transfer cannot contaminate a later successful response.
The canonical request helpers live in `scripts/release/installers/install.sh` and
`install.ps1`; website copies are generated by `release:sync:installers`.

## Installer state home

Both shell installers resolve the data home from an explicit `HAPPIER_HOME_DIR`,
otherwise following `HAPPIER_INSTALL_DIR` or the default `.happier` directory.
In current development source, the POSIX installer uses that same resolved home
for daemon commands and shell startup-file exports, preserving an explicit data
home when the binary install directory differs.

In current development source, `install.ps1` persists its resolved state home as
the user-scoped `HAPPIER_HOME_DIR` and applies it to the installer process before
post-install CLI commands. The background service and new terminals therefore
read the same credentials. An explicit `HAPPIER_HOME_DIR` selects the data home;
otherwise it follows `HAPPIER_INSTALL_DIR`, falling back to `%USERPROFILE%\.happier`.
The binary install directory can remain separate from an explicit data home.
On Windows, `HAPPIER_NO_PATH_UPDATE` skips PATH changes only, not state-home persistence.
This does not copy or migrate credentials from a previous data home.

## Desktop executable identity

Current development source configures `mainBinaryName` per desktop channel:
`happier-desktop`, `happier-desktop-preview`, and `happier-desktop-dev`. These names
keep Linux executables and icons distinct between channels and from the `happier`
CLI. The Tauri configs own the names; candidate transfer, AppImage diagnostics, and
macOS updater architecture inspection read them through the shared channel-config
resolver instead of assuming the Cargo template name `app`.

After an upgrade, open the app once so it can observe the computer's login-start
setting. The existing autostart writer re-enables the same channel's login item
with the current executable and `--menu-bar`, or removes it when login start is
off. An unknown setting leaves the item untouched; failures remain visible in
the tray and retry on the next setting observation. This reuses the existing
login-item migration rather than adding another startup preference or writer.

## Linux desktop rendering runtime

In development source, the desktop release pipeline prepares WebKitGTK 2.54.1
for AppImage bundling. The trusted Linux finalizer opts into
`.github/actions/install-tauri-linux-dependencies`; its checksum-pinned source
recipe builds on Ubuntu 22.04 with Clang 18 and GCC 12's standard library.
An exact Actions cache reuses the staged SDK. Missing helpers, unresolved native
dependencies, the wrong engine version or a newer libc ABI fail validation rather
than falling back to the distribution engine. The AppImage artifact audit repeats
the runtime validation after bundling.

Candidate compilation keeps Ubuntu's native WebKit headers. DEB and RPM packages
continue to use the installed distribution runtime; the SDK and additional GPU
helper are bundled only into AppImage. Direct Tauri development commands retain
their system-runtime behavior; the pinned runtime contract belongs to the release
pipeline. This source change does not establish availability in a published release.

WebKit can migrate IndexedDB when opening an existing desktop profile. An older
engine may then be unable to open that database; replacing the executable does
not reverse the migration. Follow the downgrade warning on the
[downloads page](../apps/docs/content/docs/getting-started/get-the-apps.mdx),
preserve pending drafts and messages, and do not delete the profile to diagnose
rendering performance. No second storage writer or profile migration is added.

## Desktop-initiated CLI acquisition

The desktop app acquires the Happier CLI itself; the user never runs an installer to connect the
computer the app is on. Acquisition is not a separate step: `runLocalHappierJsonCommand`
(`apps/bootstrap/src/systemTasks/happierCli.ts`) calls
`ensureLocalFirstPartyComponentCommand(...)` before every CLI invocation that does not already
carry a resolved CLI, so reading daemon status already downloads, verifies and installs the managed
CLI when it is missing. There is no second acquisition trigger and no persisted prefetch state —
one in-memory promise per app open. The install itself runs under the install root's mutation
lock and — because launchers and the default-channel record are shared across channels — the
home-wide activation lock (`withFirstPartyPayloadMutationLock.ts`); a concurrent installer, update
or acquisition fails on either at once. An acquisition downloads before taking them; the update
transaction takes them first, so one update per home downloads at a time. Updating an installed CLI is not acquisition: it is the one
update transaction (`runManagedCliUpdate`, see `docs/cli-architecture.md` → "One CLI update
transaction").

A task that runs several commands (or re-reads status while waiting for the daemon) resolves the
CLI once through `resolveVersionedLocalHappierCli(...)` and passes it to each command. That
resolver is also where a CLI and the version it reports for itself are established together, so
`daemon.service.status.v1` states which command answered, its provenance, and its version instead
of leaving acquisition an unstated side effect. `ensureSetupCapableLocalHappierCli(...)` is the
same resolver plus the setup version floor, and it stays on the setup path that mutates this
computer; the read-only inspection reports the version rather than refusing to answer.

Current development source reports acquisition phases through the existing system-task events,
including the acquisition performed by the initial status inspection. The release/download and
installation owners report their actual work; download counters describe archive bytes received,
with a total only when the response supplies one. They never represent overall setup completion.
The desktop coordinator exposes the inspection's task identity so a surface appearing after the
pre-auth warmup can read its current progress without starting another acquisition. Task snapshots
retain phase boundaries and the latest byte sample, rather than retaining every network chunk.
The setup ring still advances only at its existing milestones, and readiness still requires the
runtime-convergence and machine-RPC proof.

Acquisition failures carry their phase and cause; diagnostics strip URL credentials and queries.
In current development source, QA can set `HAPPIER_FIRST_PARTY_RELEASE_API_BASE_URL` to an
HTTP(S) origin on `127.0.0.1` or `[::1]` when `NODE_ENV=development`. The existing first-party
release resolver uses that origin for GitHub-shaped tag metadata; metadata supplies the asset URLs.
Paths, URL credentials, queries, fragments, malformed values and non-loopback hosts are rejected
visibly. GitHub tokens are never sent to the mirror. Build the QA hsetup with
`NODE_ENV=development node apps/bootstrap/scripts/buildBinary.mjs` after building its dependencies;
normal builds freeze `NODE_ENV` to `production` and reject the override even if the launched
process sets `NODE_ENV=development`. This is a development/QA seam, not a released setting.
The mirror must serve the publisher's unmodified archives, checksums and minisign signatures:
the existing checksum and official-public-key verification is unchanged, with no environment key override.
Retry uses the existing installed-command resolution and acquisition path. The executor's existing
abort signal reaches release requests and extraction cleanup. Installation checks cancellation
before promotion, then finishes pointer, shim, and marker finalization once started; this does not
add a cancel control or promise immediate interruption during installation.

Resolution order and provenance (`systemTasks/localFirstPartyCommand.ts`):

| Source | Provenance | Notes |
| --- | --- | --- |
| `HAPPIER_BOOTSTRAP_CLI_PATH` / `HAPPIER_BOOTSTRAP_HAPPIER_PATH` | `override` | Development only. |
| This computer chose **Keep my own** (`<happier home>/cli-choice.json` `{ mode: 'own', command }`) and that CLI exists | `override` | Wins over a managed copy still on disk (plan R12). |
| **Keep my own** is recorded but that CLI is gone | — | Fails `cli_choice_required`: no leftover managed copy and no acquisition stands in for it; setup asks first (R13 b). |
| Installed managed payload for the caller's release ring | `managed` | The desktop-managed install layout recorded it. |
| Repo-local `apps/cli/bin/happier.mjs` | `override` | Accepted on path existence alone. |
| No recorded **Let Happier manage it**, and a `happier` this layout did not place resolves on PATH | `override` | Until the one question is answered, no read acquires a second CLI beside the user's (R12). |
| Nothing resolvable | — | Acquire through the managed path, then `managed`. |

### One CLI per computer (plan R12)

When the `happier` a new terminal runs first (`resolveTerminalHappierCli`, the same search path PATH
exposure uses, including the macOS `buildServicePath` list and Windows `PATHEXT` spellings) is one
the managed layout did not place (npm, Homebrew, a manual copy), and this computer has not answered
yet, the setup executor asks once, before it writes anything: **Let Happier manage it**
or **Keep my own** (prompt `setup.cliChoice`, naming the version from that CLI's `--version`, its
path, and where it came from). The answer is recorded in `<happier home>/cli-choice.json`
(`happierCliChoice.ts`, beside `current.version` and `default-cli-release-channel.json`), so every
Happier app sharing that home and every bootstrap task resolves the same CLI. A computer with no
other `happier` is never asked and keeps the managed default; a developer override is never asked
about.

Every other copy is found by `resolveForeignHappierCli`, which walks that path **past** the managed
shim and the installer's link to it; it feeds Settings only (the old copy's row, removal command and
change action, which therefore survive **Manage** putting the managed CLI first) and never raises the
question: a terminal that already runs the managed CLI has nothing to decide (RV3-1). When Settings'
change asks about such a copy and the managed CLI answers first through something Desktop did not
create — the official installer's `~/.local/bin` link, or on Windows a `Path` entry Desktop's records
(`HAPPIER_DESKTOP_PATH_ENTRIES`/`_MOVES`) do not name — keeping it could not make the terminal run it,
so the prompt carries `keepBlockedBy` (that path), **Keep my own** is not offered, and the dialog says
that path would have to be removed first.

A working foreign CLI is not interrupted (plan R13 b): while nobody has answered, the app-open read
uses it as it is, and the question appears only when setup needs to act — a setup run, or a read that
CLI cannot serve (below). Settings › This computer › Command line offers the change whenever another
`happier` exists, including the old copy after **Manage**.

- **Manage**: the managed CLI is acquired through the existing owner, its PATH line is written even
  though another `happier` resolves (INV5 as amended by R12), and a service that runs the old CLI is
  switched through the install dry-run's `runtimeReplacement`: the recorded answer is that consent,
  so a pure runtime switch is not asked about twice. Any other ownership change (competing
  services, a manual daemon) still asks. The switch is symmetric (R13 b): after **Keep my own** a
  service that runs the managed CLI is the same `runtimeReplacement` toward the kept CLI
  (`describeDaemonServiceRuntimeReplacement` classifies a change between a user-installed and the
  managed launcher in either direction), so either answer converges the service through the strict
  `service install --replace-existing` — its failure fails setup — and `service start`/`restart`
  never rewrite a definition onto another CLI as best-effort drift. The command that removes the old copy
  (`npm uninstall -g <package>` from that package's own `package.json`, `brew uninstall <formula>`
  from its `Cellar/<formula>/` path, else just the path) is shown in Settings › This computer and
  never run (`happierCliOrigin.ts`).
- **Keep my own**: nothing is acquired, Desktop-created PATH lines are removed and none is written,
  and every command (including `service install`) runs that CLI; the CLI's service runtime owner
  (`resolveManagedDaemonServiceShimPath`) then proposes no managed shim, so the service runs it and
  `runtimeConvergence.cliVersionMatches` compares against it. Its pairing is an `override`, so the
  existing attended approval applies. Below the setup floor it fails
  `cli_own_below_setup_floor`, naming that CLI's own update command, and is never replaced.
- The question is asked again only from Settings › This computer › Command line (`reconsiderCli`),
  when the kept CLI disappeared, or when it is below the floor (a CLI that cannot report its version
  counts as below it).
  In current development source, the Settings action remains available when the active relay has
  a user-owned pinned service: the existing setup executor accepts `cliOnly` together with
  `reconsiderCli`, changes the home-wide CLI choice and PATH through these same owners, and performs
  no relay, credential or service convergence. PATH keeps its ancillary timing; managed CLI
  acquisition and required upgrades retain the existing update contract.
- A kept CLI that disappeared is still the recorded answer (R13 b). The resolver fails
  `cli_choice_required` instead of using a managed copy left on disk or acquiring one, so the app-open
  read routes into setup, whose first step asks again: about a `happier` installed since elsewhere,
  or else about the missing one by the path it was at (`setup.cliChoice` with `missing: true`).
  **Manage** proceeds as above; **Keep my own** ends `cli_own_missing` with nothing written — the
  person reinstalls it, or chooses **Manage**.
- A CLI the question is about that fails the app-open `daemon.service.status.v1` read (a pre-0.2
  build, one that errors) fails that read as `cli_choice_required`
  (`describeUnservedCliChoiceFailure`), and the app's entry policy (`deriveDesktopLocalSetupSnapshot`)
  routes it into setup rather than a Retry that only re-reads: setup's first step asks the question,
  naming the version when known and otherwise just the path. **Manage** proceeds as above; **Keep my
  own** with a CLI that cannot serve setup ends in `cli_own_below_setup_floor` and its update command.
- On Windows, **manage** also moves the managed bin dir to the front of the user `Path` when it is
  already present behind another `happier` (an npm global dir) — moved, never duplicated, and its
  added-entry provenance unchanged. The move is recorded in the user environment variable
  `HAPPIER_DESKTOP_PATH_MOVES` (`<entry>|<entries it was moved ahead of>`), so **Keep my own**
  (`removeHappierCliPathExposure`) puts it back behind exactly those entries — only while the move
  still holds (the entry is still ahead of every one of them that remains); an entry the person added
  since stays where it is, and a move they already undid is left alone. Either way the record is
  cleared. Windows builds a process PATH as the machine `Path` followed by the user `Path`, so no user
  `Path` change can put the managed CLI ahead of a `happier` on the machine `Path` (for example a
  machine-wide Node.js install's global bin); that copy keeps answering first in new terminals until
  it is removed with the command Settings shows.
- A CLI found this way must also start from the desktop: on macOS every hsetup CLI command runs
  with the same search PATH that found it (`resolveHappierCliSearchPath`), so an npm `happier`'s
  `#!/usr/bin/env node` finds the `node` beside it from a Dock-launched app; on Windows
  `runCommandCapture` runs an npm `happier.cmd` shim through the process owner's cmd.exe invocation
  (`resolveWindowsCommandInvocation`). A version manager's shim (nvm, fnm, volta) is not found, as
  for PATH exposure below.
- `daemon.service.status.v1` reports the answer and the non-managed CLI as `cli.choice`
  (`{ mode, otherCli: { command, origin, removalCommand, updateCommand } | null }`).

The release ring is never a hardcoded default: it is the **default channel's** while that
channel's managed CLI is installed — an app of another channel adopts it (plan R10 D2,
[One default channel per Happier home](cli-architecture.md#one-default-channel-per-happier-home)) —
or while this computer has any R12 answer recorded (plan R13 b: its CLI is or was a `happier` the
user installed, which follows the default channel, so the service it runs is the default channel's
and **Let Happier manage it** adopts that channel's managed CLI — the pure runtime switch the answer
consents to — rather than making the app's channel the default and leaving the user's service as
another ring's to remove, which the service consent would still ask about) — and otherwise the
caller's own (the app's variant), so a preview app on an empty home acquires a preview CLI. When the adopted default channel's newest CLI is below the floor, setup fails
`cli_default_channel_below_setup_floor`, naming that channel, its newest version, the floor and the
app's channel (wait for that channel's release, or make the app's channel the default with the
installer's `--channel`); `daemon.service.status.v1` reports the answering CLI's channel as
`acquisition.channel` (`null` for an override). `SETUP_CLI_VERSION_FLOOR` in `happierCli.ts` is the one
version floor desktop setup enforces. In current development source, replacing an installed managed
CLI below it uses `runManagedCliUpdate`, with the target floor checked before activation and the
existing staged smoke, restoration and service-restart proof. First acquisition keeps the acquisition
owner and checks the resolved release against the floor before installation; an `override` CLI fails
immediately. Only `managed` is approved for pairing silently; an
`override` CLI is put to the user once, naming the resolved path. `managed` records install
ownership, not verified publisher provenance — see
[Managed-CLI install ownership](cli-architecture.md#managed-cli-install-ownership-silent-vs-attended-approval).

## Homebrew-owned CLIs

Status: prepared, not published. `scripts/pipeline/release/render-homebrew-packages.mjs` renders
the formula (tap `happier-dev/homebrew-tap`) and the cask (intended for `homebrew/cask`) from a
stable release's real assets and its signed `checksums-*.txt`.

- The formula is a release product, never checked in. `release.yml` job `publish_homebrew_tap`
  renders it from the verified stable `cli-v<version>` release (the one this run promoted, or the
  one a resumed run's origin already promoted) and commits it to the tap. The job does nothing
  until the repository variable `HOMEBREW_TAP_REPO_NAME` is set.
- The generator refuses CLI releases before `HOMEBREW_FORMULA_MIN_CLI_VERSION` (0.2.13), the first
  whose `self update` and service launcher are correct under Homebrew. The 0.2.12 rendering is kept
  only as a test fixture.
- Happier requires macOS 13 (Ventura), from one owner: `HAPPIER_MIN_MACOS` in the generator
  renders `depends_on macos: :ventura` for the formula (inside `on_macos`) and the cask alike.
  The darwin CLI binaries (Bun) declare LC_BUILD_VERSION minos 13.0, and the desktop app installs
  that CLI, so `apps/ui/src-tauri/tauri.conf.json` declares
  `bundle.macOS.minimumSystemVersion: "13.0"` too (decided 2026-09-26). A generator test binds the
  Tauri value to `HAPPIER_MIN_MACOS`. The preview and publicdev configs merge over it without
  overriding `bundle.macOS`.
- The cask submission candidate is `packaging/homebrew/Casks/happier.rb`. Submit it for the first
  desktop release built with that minimum. Earlier DMGs declare `LSMinimumSystemVersion` 10.13,
  which `brew audit --online` would flag against `:ventura`.

- **Layout.** The formula installs the unmodified `cli-v<version>` payload for darwin/linux ×
  arm64/x64 into `Cellar/happier/<version>/libexec` (the compiled `happier` with its
  `package-dist`, `node_modules`, `tools` and `scripts`; `skip_clean` keeps Homebrew's cleaner out
  of it) and links `bin/happier` to it. The runtime root comes from `process.execPath`, which Bun
  resolves through the links to the real file in the keg, so the payload is found without the
  managed `~/.happier/cli` layout. Optional runtimes (difftastic, local embeddings) are still
  acquired on first use into `<happier home>`, as for any install.
- **Origin.** `describeHappierCliOrigin` recognises Homebrew from the `Cellar/<formula>/` segment of
  the resolved path. A compiled `happier` reports `argv[1]` as its embedded bundle
  (`/$bunfs/root/happier`), so the running CLI's package-manager origin
  (`resolveRunningCliPackageManagerOrigin`, `apps/cli/src/cli/runtime/update/cliUpdateFacts.ts`)
  reads both the invoked path and `execPath`. `self update` and the K5 update facts consume that
  one owner: `self update` prints `brew upgrade <formula>` instead of installing a managed copy,
  and remote `cli.update.v1` refuses with `cli_not_managed`.
- **Desktop.** A Homebrew `happier` is a CLI the managed layout did not place, so desktop setup asks
  **Let Happier manage it** / **Keep my own** once ([One CLI per computer](#one-cli-per-computer-plan-r12)).
- **No `brew services`.** The CLI owns its background service (`happier service install`).
  The running executable resolves into the versioned keg (`Cellar/<formula>/<version>/…`), which
  `brew upgrade` cleans up by default, so the service runtime owner
  (`resolveDaemonServiceInstallRuntimeTarget`) records the same file through Homebrew's opt prefix
  instead (`<prefix>/opt/<formula>/libexec/happier`, the `optPath` of the brew origin; the opt
  prefix is a link to the active keg). Like the managed shim, the service launches that binary
  directly with no entry path. An installed managed shim still takes precedence unless this
  computer chose **Keep my own**. The expected definition the drift check builds resolves
  to the same path before and after an upgrade, so an upgrade is not drift; a definition an older
  CLI wrote with the keg path is ordinary drift between two user-installed launchers (not a
  managed ↔ user runtime replacement) and is refreshed by `service start`/`restart`.

## Optional CLI runtimes

Current development source acquires local semantic-memory inference and Difftastic through
the existing installables policy, capability, and first-party release owners. Capability
enumeration does not download either runtime. Local inference acquires its runtime when enabled
and initialized; disabled embeddings and remote embeddings do not. Difftastic acquires on its
first RPC invocation. Development/npm installations can still use their existing package/tool
copies. Ripgrep remains in every base CLI as the target-native `rg` executable. Zellij remains in
macOS and Linux base CLIs; native Windows omits it because the terminal-host owner rejects zellij
there and uses the Windows console host.

`optionalRuntimeInstallables.ts` owns both explicit preinstallation from Machine Details →
Installables and first-use acquisition. Both use the invoking CLI's exact version under the
immutable `cli-vVERSION` release, verified signed checksums, target-specific archives, and the
existing versioned installation/promotion layout. There is no system Node or package-manager
requirement. The memory component's entrypoint is imported in the running CLI; Difftastic is
spawned directly. Optional components do not expose PATH shims or independently auto-update.

First use may wait for release lookup, download, verification and installation. Installation
status reports pending acquisition and retains the install log; failed acquisition can be
retried from Installables or on the next use. Memory initialization errors retain keyword-search
fallback; Difftastic retains its existing RPC error response. Memory worker startup and settings
reload expose their RPC diagnostics before heavyweight inference initialization completes;
pending initialization must not prevent daemon RPC registration. A matching installed runtime is
resolved without contacting the release service, including offline. Preinstalling inference
does **not** prefetch model weights: enable and warm the selected model online before offline
use. Local model inference does not send indexed text to the artifact or model download hosts;
custom remote embeddings retain their configured endpoint behavior.

The release producer emits separate `happier-memory-runtime` and `happier-difftastic` products
alongside `happier`, with each product's signed checksum envelope. Artifact production and
consumer acquisition must land together before omitting the corresponding bytes from the base
CLI. Historical releases without these optional products remain usable with their bundled copies.

The development release verifier opens each component's signed checksum envelope and extracts
all target archives through the same first-party extractor used by acquisition. Entrypoint layout
checks run for every target, including with `--skip-smoke`. On a matching host, the optional
smokes run `difft --version` and import the Transformers Node entrypoint to construct an ONNX-backed
tensor without downloading a model. `--skip-smoke` skips these optional executions; the matching
base CLI still has to attest both binary and Node-entrypoint versions, load the native command
catalog through `--help`, execute packaged `rg`
through both its version and search paths, execute packaged zellij's version path on POSIX, and run
its isolated Claude-SDK/MCP, Sharp, and PTY runtime smoke. The smoke clears `NODE_PATH`, so repository-hoisted
dependencies cannot hide an incomplete archive, and also checks the stable target-projection
invariants for unused Claude native fallbacks and Windows-only PTY inputs.

## PATH exposure

`packages/cli-common/src/firstPartyRuntime/ensureHappierCliPathExposure.ts` is the sole owner of
making `happier` resolve in a new terminal after desktop setup. It is deliberately **not** part of
`installVersionedPayload`: that installs every first-party payload, while PATH exposure is
CLI-specific and must never block setup.

What it guarantees:

- **Never shadows another `happier` unasked, never duplicates the managed one.** Before writing
  anything the owner resolves `happier` on the process PATH. If it already is the managed shim (for
  example the POSIX installer's `~/.local/bin/happier` link to `<happier home>/bin/happier`), nothing
  is added. If it is another CLI (npm, Homebrew, a checkout), what happens follows this computer's
  R12 answer: with no answer nothing is added — prepending the managed directory would silently
  change which CLI the user's terminal runs; after **Let Happier manage it** the line is written so
  the managed CLI comes first; after **Keep my own** nothing is ever written. The result names the
  other CLI as `existingCommand`, which the `cli.pathExposure.ensure.v1` result carries to machine
  settings › Terminal. The PATH checked is the desktop process's own; a GUI launch whose PATH lacks a shell
  directory can still write a line for a `happier` that shells already resolve.
- **Byte-identical lines.** The POSIX export line and shell/rc-file selection are a transcription
  of `apps/website/public/install.sh`, so if the shell installer already wrote that exact line the
  desktop writes nothing. Deduplication is exact-line equality, and on Windows a case-insensitive
  entry comparison against the user `Path`. On POSIX the installer writes its line for its own
  `BIN_DIR` (`~/.local/bin`), not `<happier home>/bin`, so the two lines are not byte-identical;
  the PATH check above, not line equality, is what keeps the desktop from adding a second one.
- **Provenance, in both directions.** A Desktop-written POSIX line is preceded by
  `# Added by Happier Desktop`; on Windows the entries Desktop added are listed in the user
  environment variable `HAPPIER_DESKTOP_PATH_ENTRIES`. Removal
  (`removeHappierCliPathExposure`, exposed as the `cli.pathExposure.remove.v1` task and a settings
  action) strips only Desktop-created entries; a pre-existing installer-owned line is never
  marked, re-added, or deleted. Exposure writes the profiles of the shell the user runs today;
  removal scans every profile file in that same table (`.zshrc`, `.zprofile`, `.bashrc`,
  `.bash_profile`, `.profile`), so switching shells after setup cannot strand a marked line.
  Windows needs no equivalent: the user `Path` and `HAPPIER_DESKTOP_PATH_ENTRIES` live in
  `HKCU\Environment` and are shell-independent. A reorder Desktop made there after **Let Happier
  manage it** is recorded in `HAPPIER_DESKTOP_PATH_MOVES` and undone by the same removal, only while
  it still holds (see [One CLI per computer](#one-cli-per-computer-plan-r12)).
- **Never gating.** The setup executor starts PATH exposure alongside the remaining service work
  and never waits for it: the app begins its readiness proof from the task result, so a
  shell-profile write must not sit between setup and the reveal. A read-only profile therefore
  produces a settings repair action, not a failed setup and not a blocked reveal. The setup result
  carries no PATH field. What *is* observable of a failure: the run emits one
  `setup.thisComputer.pathExposure` progress event just before its result **if** the write has
  settled by then (the desktop bridge stops reading hsetup's stdout at the result line), and machine
  settings › Terminal reports the current state and repairs it through the `cli.pathExposure.*`
  tasks — the surface that owns it whether or not the run got to say anything.
- **`HAPPIER_NO_PATH_UPDATE=1` suppresses writes** (`changed: false`, no failure). It is read from
  the environment of the process that performs the write — the desktop app / `hsetup` — not from
  your shell rc files, so an `export` in `~/.zshrc` is invisible to an app launched from Finder,
  the Dock or a desktop launcher (macOS needs `launchctl setenv`, Linux `~/.profile` or
  `environment.d`; the Windows user environment works as expected). The reachable opt-out on every
  platform is the remove action in machine settings › Terminal. Removal is an explicit user action
  and is not suppressed by the variable.

Limits, stated so they are not assumed away:

- **There is no uninstall hook.** No desktop uninstall path exists in the Tauri/bootstrap shell,
  and dragging the app to the Trash cannot run app code, so PATH cleanup happens only when the
  user asks for it in machine settings.
- The installer's default POSIX `BIN_DIR` (`~/.local/bin`) differs from the Desktop-managed shim
  directory (`<happier home>/bin`). When a `happier` already resolves the desktop adds nothing
  (INV5). On macOS, where an app opened from the Dock gets launchd's PATH, that check also searches
  the service PATH owner's locations (`buildServicePath`: `~/.local/bin`, `~/bin`, Homebrew's
  `/opt/homebrew/bin` and `/usr/local/bin`), so the installer link and an npm or Homebrew `happier`
  in the standard locations are detected. A version manager's shim (nvm, fnm, volta) lives only on
  the login shell's PATH and is **not** detected: the desktop then writes its line and the managed
  CLI comes first in new terminals. On Linux the check reads the desktop's own PATH; when that
  lacks `~/.local/bin`, two valid lines can coexist — both resolve the same managed binary.
- **fish is not exposed.** `install.sh` routes every shell that is not bash or zsh to
  `~/.profile`, and the desktop transcribes that table verbatim (INV5), so a fish user gets a
  `~/.profile` line fish never reads and a reload hint that is not fish syntax. Changing this means
  changing `install.sh` first — it owns the policy — and the desktop following it; until then fish
  users invoke the CLI by path or add `<happier home>/bin` to `fish_user_paths` themselves.
- On Windows the two PowerShell helpers receive their inputs (the new `Path` value, its registry
  value kind, the provenance variable name and value) through the child process environment, read
  back as `$env:HAPPIER_PATH_*`. Nothing is passed as an argument after `-Command`: PowerShell
  folds later arguments into the command text it parses, and a `Path` value contains `;`.

## Internal workspace packages

Private workspace packages such as `packages/protocol`, `packages/agents`, `packages/cli-common`, and `packages/release-runtime` are not published independently, but they must ship inside published npm packages that import them at runtime.

Published hosts currently include:

- `apps/cli`
- `apps/stack`
- `packages/relay-server`

Their `prepack` scripts run `scripts/bundleWorkspaceDeps.mjs` to copy bundled workspaces into the host package and vendor each bundled workspace's external runtime dependency tree under that workspace's bundled `node_modules`.

Current source bundling preserves package-local `imports` declarations and their conditional order, alongside `exports`. The existing workspace copier and bootstrap sync include exact relative import targets outside `dist`; external package targets still use the package's declared dependency closure. Stack bundle freshness also observes those package-root targets, so changing only an imported runtime helper requires a refresh.

## Dependency ownership

Add dependencies to the package that imports them:

- If `packages/protocol` imports a library, add it to `packages/protocol/package.json#dependencies`.
- If `apps/cli` imports a library directly, add it to `apps/cli/package.json#dependencies`.
- Do not mirror protocol-only dependencies into `apps/cli` merely because CLI bundles protocol.

Bundled workspaces are copied into the host package and are not installed by npm as independent workspace packages. The bundler vendors their external runtime dependencies based on each bundled workspace's own `package.json`.

The current source also corrects one upstream metadata gap in the shared vendoring owner:
Transformers 3.8.1's Node distribution imports `onnxruntime-common` directly without declaring it.
The vendor resolves that dependency from ONNX Runtime Node and makes it available to Transformers;
ONNX Runtime Web retains its separately required Common version. This correction applies to both
host dependency vendoring and explicit external-package bundles. Remove it when the supported
Transformers distribution declares the dependency or stops importing it. Validate this closure
outside the repository's hoisted `node_modules`, which otherwise masks the missing dependency.

Current development source keeps each Sharp dependency tree together with Yarn's existing
`nohoist` policy: the CLI, server and website use Sharp 0.35.5, while older transitive consumers
retain their own native addon and matching libvips. `sharpRuntimeSidecars.ts` resolves the
CLI/server closure from the importing workspace and stages the target packages together beside
the executable. CLI packaging excludes Sharp from its generic dependency copier so this shared
projection owns both binary layouts. Target validation resolves packages within the payload;
dependencies in the source checkout cannot satisfy a missing packaged native dependency.

Both binaries use `packages/cli-common/scripts/buildBunBinary.mjs`. It bundles Sharp's public
CJS entry, preserving Sharp's platform selection, CPU checks and error reporting, and redirects
only the resolved native addon import to its staged file. The filename comes from the actual
native import, preserving libvips adjacency without embedding renamed Bun native assets.
These redirects are virtual modules: compilation does not read optional foreign-platform
addon files that Sharp never selects on the requested target. A selected missing addon still
fails visibly through Sharp's runtime loading path. The platform shims' guarded
`require.resolve('@img/sharp-libvips-*/binary')` hints stay external, so the executable does not
embed every installed platform's libvips; the selected library ships only as its sidecar.
This does not enable Bun's package-json autoloader; the CLI also keeps dotenv autoloading
disabled. The canonical Bun compiler defaults disable bunfig autoloading for standalone CLI, server, hsetup, hstack and Prisma
migration executables, so a working directory cannot inject a preload before startup.
Both custom Bun build adapters consume the same defaults.

Binary artifact finalization projects native dependencies from the requested artifact target,
not the build host: ONNX Runtime Node retains its target OS/architecture directory with all
support libraries, and PTY packages retain target prebuilds plus source-built Release/Debug
assets. POSIX artifacts omit PTY's Windows-only ConPTY, winpty, and `src/win` inputs, plus
the Windows terminal/agent modules, console workers, and their corresponding source and tests.
Windows omits the Unix terminal modules and tests, POSIX-only prebuild loader, and `src/unix`;
it keeps the selected ConPTY architecture and its build inputs. Both retain shared entrypoints,
types and helpers, including Homebridge's unconditionally imported `prebuild-file-path` module.
The shared PTY permission owner
repairs `spawn-helper` in both build and prebuild locations during package installation and
artifact finalization. Foreign `ps-list` fastlist executables are omitted on non-Windows targets;
Windows keeps them. In current development source, the shared Bun compiler loads `ps-list`
on Windows from the existing on-disk dependency payload through the canonical CLI runtime-root resolver,
including installed channel shortcuts. This preserves the dependency's own parser and Windows
helper lookup: bundling its `import.meta.url` would point at Bun's virtual filesystem instead.
POSIX keeps the dependency's JavaScript embedded, including in detached installer runners.
The legacy Claude SDK launcher records unverified process cleanup through the existing
primary-session turn lifecycle, allocating a failed turn when idle, before preserving the
resume identity and exiting. Failed issue publication is logged and does not admit a replacement.
Happier's Agent SDK runner always supplies the separately installed Claude
Code executable, so standalone artifacts keep the SDK's JavaScript package but omit its unused
optional native CLI fallback packages. Target-specific standalone payloads retain executable
source maps for Bun and Node diagnostics and dependency declarations for SDK/plugin authoring.
They omit only dependency declaration maps and TypeScript incremental build metadata, which are
neither compiler inputs nor runtime diagnostics. The binary payload's root `package-dist` also
loses its redundant CJS build and declarations because its supported runtime entrypoints use ESM.
Apart from those package-specific foreign-platform inputs,
runtime JavaScript, JSON and native assets, licenses, documentation, examples, tests, dependency
CJS sidecars, and npm/library output remain intact. We deliberately do
not use a generic directory-name denylist for third-party packages. A small audited set of nested
dependency copies is removed only when the surviving ancestor is reachable from that consumer,
the two trees are recursively byte-identical without symbolic links, and direct peer resolution is
unchanged; missing, shadowed, divergent, peer-dependent, or linked copies are retained.

In current development source, the PTY provider uses the existing Python relay on
POSIX Bun. Both native packages use `tty.ReadStream` for a nonblocking PTY master;
Bun can return a successful spawn without working input/output
([upstream issue](https://github.com/oven-sh/bun/issues/25822), reported on macOS through
Bun 1.4.2 and still open). On Linux x64, a `node-pty` interactive input/output and exit probe
passes on both Bun 1.4.2 and the bundled 1.4.4, so it cannot show the issue is fixed; macOS has
not been re-checked on 1.4.4. Module-load success
therefore cannot establish backend usability. Re-enable native POSIX selection
only after the bundled runtime passes interactive input/output and cleanup checks.
The relay requires Python 3, applies the initial window size, and reports
`terminal_resize_unavailable` for subsequent resizes. Node-hosted and Windows
backend selection are unchanged.

## Internal dependency closure

`vendorBundledPackageRuntimeDependencies(...)` vendors external dependencies only. It intentionally ignores `@happier-dev/*`.

If a bundled workspace imports another internal workspace at runtime, the host package must also bundle that internal dependency. For example, a host that bundles `@happier-dev/cli-common` may also need `@happier-dev/agents` and `@happier-dev/protocol` if they are in the runtime import closure.

## Adding a bundled internal workspace to CLI

When introducing a new `packages/<name>` that must ship with CLI:

1. Add it to `apps/cli/package.json#bundledDependencies`.
2. Add it to `apps/cli/package.json#dependencies` with workspace version `"0.0.0"`.
3. Add it to the `bundles` list in `apps/cli/scripts/bundleWorkspaceDeps.mjs`.
4. Update CLI bundling and published-dependency tests.

## Missing `dist` / invalid exports

Internal package `exports` point at `dist/**`. If `dist` is missing, consumers can fail with invalid-export errors.

Fix by building the workspace, for example:

```bash
yarn workspace @happier-dev/protocol build
```

Stack builds should fail fast or build missing internal workspace outputs through the stack build helpers.

## Bundling sanity checks

When touching bundling or dependencies, run the relevant source-level script and dependency-closure tests. For CLI changes, the check should prove that protocol dependencies are projected under the bundled protocol workspace path, not duplicated at the host root unless the host imports them directly. Feature QA does not produce or install a local release archive; release automation owns the archive it publishes.
