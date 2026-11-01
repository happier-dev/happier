# Binary-Safe Runtime and Bundled Workspaces

Happier ships binary installers. First-party runtime paths must work on machines that do not have system `node`, `npm`, `npx`, `pnpm`, `yarn`, or `bunx`.

## Native language-server acquisition (0.3 development source)

The bundled `lang-typescript` plugin declares native TypeScript 7.1.0-beta as a
managed-first internal prerequisite through the existing `managedDependencies`
family. Each Linux, macOS and Windows x64/arm64 npm platform archive has a pinned
SHA-256 digest. The pinned-archive installer verifies that digest and retains the
complete archive root. The selected executable is `package/lib/tsc`, or
`package/lib/tsc.exe` on Windows; its adjacent `lib.*.d.ts` files remain available
to the native server. It is not a package-manager launcher or project binary.

`contributes.languageServers` references that dependency and declares
`['--lsp', '--stdio']`. Automatic type acquisition is disabled through its
initialization options; external-code execution and telemetry are not enabled.
The Machine host starts the process for an explicit language query or when the
person enters Edit, using the existing managed executable resolver, protocol
client and supervisor. View and Changes keep on-demand startup. Entering Edit
shows the server's starting state while initialization completes; it does not
authorize project code.
Declaration and acquisition ownership apply equally to external plugins; a
`systemTools` reference uses the existing declared system-tool owner instead.

The development `lang-web` plugin declares JSON, CSS/SCSS/Less and HTML servers
from `vscode-langservers-extracted@4.10.0` through the generic
`managedJavaScriptPackage` dependency source. An explicit dependency install
uses the existing managed package coordinator, pinned package version and
`--ignore-scripts`. Launch reads that installed package's exact npm `bin` entry
and runs it with the existing managed JavaScript runtime's absolute executable.
It does not execute the npm shell shim, search PATH, install a missing runtime,
or fetch a package when a file opens. Missing prerequisites use the ordinary
Install flow. External plugins use this same source and resolver.

The development `lang-markdown` plugin declares native Marksman 2026-02-08
through the checksum-pinned executable-asset path. Its release supplies Linux
x64/arm64, universal macOS, and Windows x64 assets; Windows arm64 is unavailable.
The plugin retains the MIT license notice. It requires no Node or .NET runtime.
Cross-file Markdown features use an existing Git root or `.marksman.toml`;
opening a document does not create a project marker.

Project diagnostics run only on an explicit request. When workspace diagnostic
pull is unavailable, a language-server declaration may supply `projectCheck`
with its own declared executable, arguments, root-relative `projectFile` and
output codec. The bundled native TypeScript checker uses `--noEmit --pretty
false --incremental false -p tsconfig.json`. It shares managed execution,
cancellation, plugin retirement and Processes custody with the LSP host.
Diagnostics stream independently of the supervisor's retained output preview;
no result-count or output-size cap is imposed by the checker.

## Runtime contract

In current development source, `scripts/pipeline/release/bun-standalone.entitlements.plist`
owns the macOS hardened-runtime permissions for shipped Bun executables. Standalone
signing consumes it directly. Desktop sidecar preparation derives
`apps/ui/src-tauri/Entitlements.plist` from this policy plus the desktop's
camera and microphone permissions; the committed projection also serves bundle-only
finalization. Tauri applies that file when signing the app and external binaries,
including `hsetup`.
The desktop's shared `apps/ui/src-tauri/Info.plist` also declares camera,
microphone, and speech-recognition usage descriptions for macOS privacy prompts.
Signature validity and notarization alone do not prove startup: release validation
must inspect the bundled helper's JIT entitlement and execute `hsetup --help` on
the native target without disabling JIT.

The daemon owns Plugin UI compilation and invokes the SDK's bundled esbuild
implementation from the published workspace dependency closure. Shipped hosts
do not spawn Vite, Re.Pack, Metro, Node, or a package manager to load a plugin.
They evaluate the verified CommonJS bytes in the app realm through the fixed
host-module map.

Do not introduce direct product-runtime calls to:

- `spawn('node', ...)`
- `npm`, `npx`, `pnpm`, `yarn`, `bunx`
- shell installers from UI/daemon/runtime code
- PATH-only agent/runtime detection as the sole source of truth

These are allowed only behind centralized managed runtime/tooling abstractions.

In current development source, Windows command discovery and invocation share
`packages/cli-common/windowsCommandInvocation.mjs`. A recognized npm wrapper that
only forwards arguments to an existing native `.exe` resolves to that executable,
avoiding `cmd.exe`'s smaller command-line limit (including Claude Code's native npm
installation). Other command scripts retain shell execution and its existing
quoting, including npm JavaScript wrappers and wrappers whose target is missing
or still a text placeholder. Recognition does not choose a different installation
or modify the subprocess environment.

In current development source, the PTY provider uses the existing Python relay on
POSIX Bun. Both native packages use `tty.ReadStream` for a nonblocking PTY master;
Bun 1.4.2 can return a successful spawn without working input/output
([upstream issue](https://github.com/oven-sh/bun/issues/25822)). Module-load success
therefore cannot establish backend usability. Re-enable native POSIX selection
only after the bundled runtime passes interactive input/output and cleanup checks.
The relay requires Python 3, applies the initial window size, and reports
`terminal_resize_unavailable` for subsequent resizes. Node-hosted and Windows
backend selection are unchanged.

In 0.3 development, remote SSH machine setup installs the selected CLI through
the canonical first-party payload installer after host trust and before relay
installation, service inventory, or Home enrollment. SSH command execution and
both payload strategies share the path-quoting owner in
`packages/cli-common/src/ssh/shellQuote.ts`: only the leading `$HOME` expands;
the remaining path and caller-supplied command arguments stay literal.

Managed-machine bootstrap in 0.3 development uses that same payload installer
and `remote.ssh.bootstrapMachine.v1` task recipe for SSH and native transports.
Native transport supplies admitted guest exec and binary file delivery only;
the host retains the resource identity, task lifetime, prompts and normal v3
Home enrollment. Native enrollment requires only buffered exec: normal finite
`auth request` retains claim secrets in protected guest pending state, the task
obtains approval, then `auth wait` registers the same guest. Live output observers
are optional and apply only to the selected guest process, not prerequisite
inspection processes. Provider-reported SSH key
evidence must match a fresh scan but cannot approve replacing saved host trust.

The remote enrollment recipe shares one budget across request, consent and wait.
In 0.3 development, service installation and startup also consume the remaining
enrollment lifetime through the CLI's `--wait-timeout-ms` service argument. The
service owner charges its preflight and launch against that budget, waits for a
slow active service to publish the selected Home's owner, and ends the ownership
check without adding its standalone grace window. The supplied budget is a
remaining duration; guest CLI bootstrap before service-command entry is outside
this check. An observed service exit
or incompatible published owner ends this finite wait early. A discovered daemon
process without an ownership file remains pending; it cannot yet prove its
version or service identity. Systemd's inactive restart transition and a previous
run's exit properties alone do not prove startup failure. Finite failures report
the predicate code, elapsed ownership waiting and available budget separately.
Standalone service commands
keep their existing startup checkpoints and platform defaults. The controller
and guest CLI must both be updated for this propagation.
In current development source, macOS install/start/restart select kickstart-only
only when the native launchd activity reader confirms that the service-owned
daemon's job is loaded. A surviving process marker alone cannot skip bootstrap.
This correction requires an updated guest CLI payload and retains GUI placement.
The consent prompt ends at the earlier recipe deadline or Home request expiry,
with `auth_enrollment_timeout` or `auth_request_expired` and a request to Retry
setup; late consent cannot authorize the expired request. Finite `auth wait`
failures project a credential-free code through the buffered enrollment error,
including local expiry and argument/state validation. These are development
source changes. Buffered auth failures also retain the auth phase, HTTP status
and known Home database availability code through the shared diagnostic
allowlist. Arbitrary server error values, response bodies and native output
remain excluded from that cause projection. Transient Home HTTP, network and
timeout failures are classified
as `AUTH_WAIT_HOME_UNAVAILABLE`; the wait does not replay the one-shot claim.
After a successful claim, buffered and streaming enrollment retain that response
and retry transient authenticated Home observations and Machine registration
within their existing lifetime, using the existing polling cadence. Admission
refusals remain terminal, and managed enrollment saves its bearer only after
registration succeeds. Retry after an unsuccessful attempt requests fresh
approval while retaining the guest's Machine identity. Feature-read diagnostics
preserve the HTTP status or transport failure for the shared recovery policy.
During managed enrollment, the controller's repeatable `controller/current`
observations use that same Home retry policy and the remote recipe's existing
deadline and polling cadence. Native effects, submission and report mutations
are not replayed. Native installation starts this existing budget before
`ssh.installCli`, and sign-in consumes its remaining time rather than renewing
it. If the budget expires during installation before sign-in starts, the
operation fails with its Home diagnostic and the retained machine supports
Retry install. Connection-loss Prisma errors (`P1001`, `P1002`, `P1017`) use
the server's existing `503 database_connection_unavailable` classification;
that availability result does not establish rollback or permit transaction replay.
If Home remains unavailable after sign-in starts and the lifetime ends, Create or
bootstrap Retry retains `action_outcome_unknown` as an `outcome_uncertain`
operation rather than claiming the guest failed; enrollment may already have
committed. This controller-side recovery requires a controller refresh.
Shared offline warnings use stderr, keeping finite command stdout valid JSON
when post-claim machine registration fails.
A failed wait process without a usable diagnostic code reports
`AUTH_WAIT_PROCESS_FAILED`, distinguishing absent output from an invalid
diagnostic envelope. An invalid envelope identifies the first failed check
(`parse`, `v`, `ok`, `kind`, or `code`) without copying rejected values. Safe
unrecognised error codes remain reportable data; they do not need a controller
allowlist. The recipe retains the exit without exposing native output or
inferring an authentication cause. When native execution ends before a usable
finite response, the existing terminal failure retains the validated termination
kind, exit status when observed, truncation flags and allowlisted diagnostic
code. Native stdout, stderr, diagnostic messages and signal values are excluded;
no HTTP cause is inferred from termination alone. Controller and guest CLI reloads
are required; the server's
terminal-request TTL policy is unchanged.

For source-built guest QA in 0.3 development, an operator can set
`HAPPIER_FIRST_PARTY_REMOTE_CLI_PAYLOAD_ROOT` on the controller to a prepared,
target-compatible CLI payload directory. The shared payload installer consumes
this input for managed native, managed SSH and SSH setup, using the same archive,
delivery and promotion path. A bad local payload fails with `invalid_payload`
instead of falling back to a release; without the input, normal verified release
acquisition is unchanged. Build the directory through the existing
`buildCliBinaryArtifactPayload` owner; it is an explicit trusted operator input,
not a release publication. Existing controllers need the input in their daemon
environment and the shared installer change needs reload.

For an already enrolled service-managed native guest, the admitted managed
bootstrap Retry updates the CLI through that same installer and reinstalls its
background service through the CLI service owner. It retains the existing Machine
registration without another pairing request. Native-process guests instead
retry their retained boot configuration without reinstalling or pairing.

The shared remote Home enrollment recipe recognizes the ordinary `auth request`
JSON emitted by `cli-v0.2.16`, and its status-1 `Unknown auth subcommand: enroll-remote`
response with auth help, returning `remote_cli_update_required` before approval.
The SSH executor preserves the process status and stderr for that shared decision.
Managed native, managed SSH and SSH Home setup consume that same
boundary. Older ordinary requests are never accepted as enrollment, and their
stdout is never included in errors because it can contain claim and pairing
secrets. Malformed or unrecognized responses remain `invalid_cli_response`.
This behavior is development-only and needs reload on existing controllers.

Before adding or changing an agent runtime, managed dependency, install, or update flow, classify it as one of:

- system-first agent CLI
- managed-first internal prerequisite
- managed package
- vendor install recipe
- managed JS-runtime dependent

Agent detection, install status, daemon validation, runtime spawning, and UI/managedDependencies must reuse the same source of truth. Agent CLIs should prefer user/system installs by default over Happier-managed installs unless an explicit setting says otherwise.

In current 0.3 development source, Pi's vendor-managed launcher is a system-install
candidate declared by its plugin: `PI_CODING_AGENT_DIR/bin/pi`, then
`~/.pi/agent/bin/pi`, when `PATH` has no matching executable. Explicit
`HAPPIER_PI_PATH` remains exclusive and the existing Happier-managed source
preference remains authoritative. Detection, version probing and launch consume
the shared Agent resolver; the vendor launcher owns its pinned Pi release and
JavaScript runtime environment.


In current 0.3 development, Codex's plugin manifest already allows 384 MiB per
archive file and 512 MiB in total. The digest-verified Windows x64 `rust-v0.163.0`
archive expands to 465,689,987 bytes, within that allowance; this does not change
the plugin's separately qualified release pin. Shared extraction still accounts
for all members and retains its path, link, count, digest, and decompression
protections. A total-size refusal is carried from the extractor through the
installer and typed daemon job as `archive_expanded_byte_limit`. The existing
install-job presenter supplies localized upgrade guidance to Agent and Updates
surfaces. A refused archive never replaces the previous managed runtime.

In 0.3 development, Agent install/update jobs wrap the canonical managed installer
in the daemon; browser, phone, and dedicated CLI callers submit to that same owner.
Vendor recipes stay inside this abstraction and require explicit consent. Managed
package acquisition uses the managed pnpm selection/bootstrap owner: if no usable
managed or explicit override command is available, it fails rather than falling
back to `pnpm` on `PATH`. See
[Agent install and update jobs](./agents-catalog.md#agent-cli-install-and-update-jobs-03-development).

In 0.3 development, MCP servers and configured ACP command launches share the
package-runner normalizer. For pnpm-backed commands, it ensures pnpm and a
JavaScript runtime, then carries the runtime paths and managed pnpm environment
into the child launch. This lets
package binaries with a `#!/usr/bin/env node` entrypoint run without Node on the
user's PATH. Selecting an absolute launcher executable alone does not prepare
the package's child processes.

In 0.3 development, the same normalizer maps `uvx` and `uv tool run` to
Happier-managed uv. Its pinned release assets and publisher SHA-256 digests are
owned by `packages/cli-common/src/agents/managedUv.ts`; acquisition uses the
existing verified downloader, archive extractor, install lock and promotion
owner, without a GitHub latest-release API request or system uv fallback.
uv's cache, tool and managed Python directories live under the Happier home.
Registry uv Agents install through the existing definition job/first-use path
into their Account/definition/version root, including their managed Python,
tool environments and launchers. Removing shared uv bootstrap/cache state does
not remove a retained Agent's interpreter. Their virtual environments stay at
that final location because they embed absolute interpreter paths. Install and
uninstall commands use the existing process-tree cancellation owner. Runtime
overrides contain only the owned directories and managed Python preference;
authored index and authentication settings retain their normal child-environment
priority.

One request-scoped exception exists: `AgentCliSourcePolicy` (`packages/cli-common/src/agents/resolution.ts`). Passing `sourcePolicy: 'managed_only'` to the canonical resolver, install preflight, or `prepareAgentCliForRuntime(...)` restricts that single request to the managed install under its own `HAPPIER_HOME_DIR`: environment overrides, system/global installs and vendor recipes are ignored, and a retry may reuse a valid current managed install. It is a per-request argument, never a persisted or environment-configurable preference, because a composition that may run only what it installed itself (the temporary-computer Runner) must not be widened by the endpoint's environment. Such a composition passes the returned resolution unchanged into the launch through `buildAgentCliLaunchSpecFromResolution(...)`; resolving again at launch would let an override or system binary substitute itself between readiness and launch.

Model Provider endpoints are not Agent executables. Provider discovery may use only the bounded detector and local-command declarations owned by the Provider contribution and the canonical local-services/runtime abstractions. An adopted local service is observed but never stopped or restarted by Happier. A Provider process started through the managed-local-service path is owned by that path; Provider code must not spawn `node`, package managers, or vendor commands directly. See [Providers](./providers.md#local-discovery-and-process-ownership).

In current development source, vendor installers preserve the Windows process
environment's `Path` spelling; cloning that environment and replacing it with an
empty `PATH` prevents executable resolution. Only POSIX recipes prepend user
install directories. Windows recipes declare `powershell.exe` in their owning
Agent plugins, which also supply the copyable installation guidance.

## Installer GitHub authentication

In current development source, the standalone Bash and PowerShell installers prefer
`HAPPIER_GITHUB_TOKEN` over `GITHUB_TOKEN`. A token rejected with HTTP 401 triggers
an anonymous retry and a visible warning, including outside verbose mode. Other
failures retain authentication for the existing retry policy. Bash buffers metadata
responses so a failed transfer cannot contaminate a later successful response.
The canonical request helpers live in `scripts/release/installers/install.sh` and
`install.ps1`; website copies are generated by `release:sync:installers`.

## Installer state home

In current 0.3 development source, managed runtime custody accepts filesystem
aliases of the same install parent, including symlinked homes, Windows junctions
and macOS `/var` → `/private/var` aliases. The shared version-root identity owner
resolves parent aliases before layout membership checks. `current` and `previous`
still require their canonical `.version` markers, and the selected physical root
must remain an exact immutable child of the physical `versions` directory. A
version symlink that escapes that directory is rejected.

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

## Native computer driver (0.3 development source)

The built-in `computer-cua-driver` installable descriptor owns native driver
0.37.0 asset/version pins (`cua-driver-rs-v0.37.0`; macOS universal, Linux
x86_64/arm64 and Windows x86_64/arm64 `-binary` archives, each SHA256-pinned). `apps/cli/src/packagedRuntime/installables/sourceAdapters/computerCuaDriver.ts`
projects native launch and capability repair through the shared pinned-archive
installer, checksum/version validation and executable resolution.
Explicit repair uses the admitted `machines.capabilities.install`
Action with `dep.computer-cua-driver`, sharing the native launch installer's
retained `tools/computer-cua-driver/current` directory and executable validation.
Discovery refuses a missing driver with `driver_unavailable`; opening the picker
does not install software. Installation remains with the admitted capability
Action and the installable descriptor's required consent.
The Computer picker and viewer re-read native grants and source/control facts
after repair; successful installation alone never grants permission or input.
`daemon/computer/driver/nativeTransport.ts` launches that installed absolute executable
directly in embedded MCP mode; no system Node, package manager or second launcher is involved.
Desktop connection/authentication/session variables are forwarded only on Linux.
An explicit X11 connection receives `DISPLAY`; a selected Wayland connection
receives its inherited `WAYLAND_DISPLAY`, runtime/session-bus environment and
compositor identity (`HYPRLAND_INSTANCE_SIGNATURE` or `SWAYSOCK`). The transport
enables Cua's native Wayland backend and omits XWayland's `DISPLAY` from that
process, so X11 metadata cannot masquerade as native desktop geometry.
The macOS bare `-binary` executable serves the embedded MCP line (observed on macOS 26 with 0.37.0:
`initialize`, `tools/list` and tool calls work; the 0.36.0 "run `CuaDriver.app`" notice is not
raised by that line, and embedded status reflects the host process's Screen Recording and
Accessibility grants). The transport requires `initialize` to report exactly the pinned version. Accessibility-tree reads
send `full_output: true`; since 0.37.0 the driver's default response omits the structured
`elements` array and uses lower walk limits.
On Linux, run the daemon in the intended X11 desktop session, with its `DISPLAY`
and any required `XAUTHORITY` already set. A headless host needs an explicitly
started X11 desktop, such as an operator-owned Xvfb fixture; installing the driver
does not create one. The daemon captures its default display when constructing
the Computer routes, so exporting `DISPLAY` in a later CLI does not update an
already-running daemon. The operator must reload that daemon with the intended
desktop environment. Callers that supply `computer.targets.list.displayId` can
inspect that exact X11 display without changing the default; the selected target
retains the same explicit display identity. Happier does not select an unrelated
display merely because its socket exists.
The same driver validates window/primary-desktop PNG dimensions and retained capture
geometry. Its viewer process cannot evict the model process's one-shot action binding.
Unknown input completion quarantines the source without replay. Explicit target
reselection waits for actual exit of the old native process before replacing
the source; the replacement needs a fresh capture before input. Requesting
process termination alone is not retirement proof.
Windows uses the driver's native `primary` desktop without requiring a display
environment variable. Its screen dimensions, screenshot pixels and desktop input
coordinates are physical pixels even at high DPI; the reported DPI scale does
not rescale those coordinates. Windows has no separate capture permission prompt;
the native `post_message` capability reports ordinary input availability without
requiring elevation. Native capture, UIPI and delivery failures still refuse.
Window input stays in background mode. Only the pinned pre-dispatch class refusal
is known nondelivery; an unresolved UIA call carrying the same
`background_unavailable` code retains unknown completion. No automatic foreground
escalation is performed.

On a Wayland desktop, the default connection is the daemon's inherited socket,
ahead of its XWayland connection. Explicit X11 targets remain exact. The driver
lists only native pid/window identities it can enumerate; it offers a desktop
only when its native `get_screen_size` supplies valid geometry. In Cua 0.37.0
that content-free Wayland desktop metadata is Hyprland-specific. Other compositor
window paths may be available, but a working screenshot alone does not establish
desktop selection or safe input coordinates. When no target can be enumerated,
`wayland_target_unavailable` explains the compositor limitation. Cua's enabled
Wayland-session flags establish backend availability; they do not certify a
particular compositor's capture/input protocols or bypass native portal grants.
No compositor, plugin or portal helper is installed automatically.
Archive availability is not source readiness. Native Windows and compositor
capture/input certification remain release checks requiring interactive native
Machines; process-boundary tests do not supply that evidence. The portable
primary desktop is not a per-monitor identity catalog.
See [Computer target consent](actions.md#computer-target-consent-03-development-source)
for the current source, approval, independent native grants and confidential-entry limits.

## Development/QA first-party release mirror

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
The vendor-owned, exact-version Mutagen engine follows its existing separate acquisition contract.

## Internal workspace packages

In 0.3 development, `apps/stack/scripts/provision/.bun-version` is the single
Bun build/provisioning version owner, currently 1.4.4. This includes the
[GHSA-26q8-h657-pf84 TLS trust-store correction](https://github.com/oven-sh/bun/security/advisories/GHSA-26q8-h657-pf84);
standalone executables compiled with an affected Bun must be rebuilt.
CI setup reads that file; managed Lima
readiness and streamed Lima/WSL provisioning consume the same value. Downloaded
Ubuntu provisioning needs the companion file from the script's same source ref,
or an explicit `HAPPIER_PROVISION_BUN_VERSION` override. Component builders still
resolve the selected executable and record its actual version in build identity;
this pin is not a managed Agent runtime or a change to installed product state.
The shared `resolveBunCompilerCommand` owner checks the selected executable's actual
version against this file before every standalone compile, including Prisma migration
support and directly invoked Bun build runners. Callers that omit `repoRoot` use
the compiler module's checkout root, independent of their working directory.
`HAPPIER_BUN_PATH` selects an
executable, but does not waive the pin. A mismatch fails with the required and
observed versions; install or select the pinned compiler and rebuild. Isolated
QA build recipes must acquire the archive for that version rather than reuse an
unversioned `bun.zip` without checking its contents.

In 0.3 development, `dev-targets host prepare NAME --toolchain` also prepares
user-local Rust through `packages/iroh-native/scripts/ensure-rust-toolchain.mjs`.
Its streamed Ubuntu toolchain profile installs `build-essential` and `pkg-config`
when native prerequisites are absent, and verifies `cc`, `c++`, `make`, `ar`, and
`pkg-config` before reporting readiness. The profile also verifies Node/npm,
Go and ripgrep; already ready hosts skip installation. Source dependency bootstrap
installs the exact, integrity-checked pnpm version from the root `packageManager`
pin after synchronization through `scripts/ci/setup-pnpm.mjs`.
The controller streams that installer and the package's `rust-toolchain.toml`
pin to the selected SSH account, including after `--create-user`; Rust installation
runs without elevation and adds no mobile or WASM targets. A ready pinned compiler
is reused. Run native addon builds from `packages/iroh-native` so Cargo selects
that package's toolchain pin, with its user-local Cargo bin directory on `PATH`.
Worker source mirrors exclude Iroh's `native/` and `native-test/` outputs so a
later synchronization barrier preserves the worker's architecture-specific addon.
Apply changed exclusions to existing mirrors through the routing producer's
`dev-targets sync-service start --detached`; ordinary flushes use the existing
project's rules.

Private workspace packages such as `packages/protocol`, `packages/agents`, `packages/cli-common`, and `packages/release-runtime` are not published independently, but they must ship inside published npm packages that import them at runtime.

Published hosts and bundled libraries currently include:

- `apps/cli`
- `apps/stack`
- `packages/relay-server`
- `packages/support`
- `packages/plugin-sdk`

Their `prepack` scripts run package-local `scripts/bundleWorkspaceDeps.mjs` adapters. The shared publisher stages each workspace with its external runtime dependency tree and publishes the internal dependency closure in dependency-first order. In 0.3 development, Stack prepares its producers before taking publication custody, then calls `scripts/workspaces/syncBundledWorkspacePackages.mjs` for copy verification and repair through the same per-package publisher.

Current 0.3 workspace bundling preserves runtime package-local `imports` declarations and their conditional order, alongside `exports`. Compiled bundled copies omit the development-only `happier-source` condition at every level of both maps, so source-enabled callers still resolve their complete compiled runtime. Authored source tools continue selecting workspace roots through the canonical source resolver. The existing workspace copier and bootstrap sync include exact retained relative import targets outside `dist`; external package targets still use the package's declared dependency closure. Live bundle health checks compare the retained import map and target files. Stack uses the canonical copier's content verification for producer outputs, package-root targets, declared resources, vendored dependencies and destination bytes; unchanged repeats copy no bodies and write no destination files.

In 0.3 development, CLI testkit and publisher runtime-tree checks share the
workspace health owner. Third-party declaration-only targets (`types`, including
nested export conditions) do not determine runtime health: some published
dependencies omit those files. Executable targets and dependency versions remain
required, as do first-party declared output files, including declarations.

Publication has two explicit modes. Live source-dev refreshes keep each physical consumer package directory mounted, publish complete files with `package.json` last, retain prior targets for in-flight module resolvers, and roll back already-published files if a later replacement fails. The shared publisher replaces a consumer workspace symlink or junction with a private directory rather than publishing through it into producer inputs; failed publication restores the link. Stack's live copier preserves links to the canonical source workspace, while explicit artifact publication detaches them into physical packages. Artifact publication is selected by npm `prepack` or `--artifact` and prunes retained targets so obsolete generations cannot enter a tarball. Both modes use the package build owner's content record to admit current `dist` outputs, including source additions and deletions, build inputs, compiler identity, and declared output bytes. Health checks require every current source runtime file to match but deliberately allow extra retained targets in live trees.

Public npm/SDK publication retains the workspace package-build owner, dependency
graph admission, captured package inputs, compiler state, currentness records and
publication locks. Strict packing/publishing still requires checked declarations
and valid runtime outputs. The public CLI package keeps CommonJS/ESM exports with
matching declarations. Its strict native compiler emits the checked declaration
graph once; pkgroll bundles that graph into public CommonJS/ESM declarations,
with internal aliases resolving inside the checked graph rather than reopening
TypeScript source. Pkgroll remains an npm-publication tool, not a prerequisite
for native executables or source QA.

Remaining workspace dist consumers share build-mode selection and compiler
arguments through `packages/cli-common/workspaceChildBuildEnv.mjs`, including the
generic package emitter and cli-common's atomic compiler. `source-dev` and
`qa-runtime` use incremental unchecked emission; ordinary builds default to
strict, and public packing/publishing forces semantic checks before replacing
last-green output. This policy concerns package outputs, not native source
construction or the public no-emit typecheck.

In current 0.3 development, admitted package builds retain the shared foreground
process custody until cancellation settles. Cancelling a running build reaps its
compiler and preserves the prior `dist`; cancelling a queued build releases its
waiter without disturbing another publisher. The build reports the caller's
actual signal, while ordinary numeric compiler exits remain numeric.

In current 0.3 development, the explicit `happier-source` condition resolves
first-party source. Native CLI construction and retained source QA share the entry
authority in `packages/cli-common/sourceRuntimeEntries.mjs`: CLI exports/imports,
bundled plugin daemon entries and declared Agent runner leaves join one esbuild
graph. Native code construction rejects first-party dist/generated runtime inputs.
Bun compiles a launcher that loads the emitted physical ESM graph from its own
payload. It does not run pkgroll, the public declaration compiler, or a prior
CLI dist build.

These two emitters and their bundled executable sidecars also share the output
policy in `sourceRuntimeEntries.mjs`. esbuild removes whitespace and ordinary
comments, lowers tagged templates before ASCII emission, and retains exact legal
comments in adjacent `.LEGAL.txt` files. Identifiers stay unminified, preserving
named stack frames and emitted file/line/column locations. This avoids widening
whole V8 Script source strings for Unicode comments or raw template text. esbuild
does not escape Unicode regular-expression literals; first-party regex owners
use equivalent Unicode escapes to keep those source graphs Latin-1-safe.

Retained source daemon bundles also compile bundled Plugin UI graphs through
`prepareSourcePluginUiArtifacts.mjs`, the same SDK compiler/inventory owner used
by native CLI construction. The generated manifests and complete file sets live
beside the emitted plugin packages and participate in the bundle's code identity.
Source daemon projection resolves those package-local graphs before linked
checkout dependencies: republishing checkout `dist` must not change bytes served
for a retained projection's digest. Selecting a newer source bundle replaces the
projection; genuine integrity mismatches still fail closed. Bundle reuse and
pending source preparation share the compiler/inventory input list, including
the UI package metadata, so correcting these inputs can resume preparation.

Retained source daemon bundles build the first-party process-custody helper and,
when CLIProxyAPI is bundled, its managed wrapper from captured current Go source
through their existing native staging owners. They do not borrow a checkout's
previously built first-party executables. Native sources, module files, build tools
and licenses participate in the bundle's existing reuse checks and startup
preparation watcher. Managed executable resolution admits physical executables
from the exact executing source root; prepared distributions retain their packaged
asset-integrity checks. Go source diagnostics use the existing drift classifier,
so correcting a failed native build resumes pending preparation; configuration and
OS errors still fail fast. Installed vendor tools retain their lifecycle.

Native server construction resolves `main.light.ts`, `main.ts`, and the packaged
migration entry through that same source export owner. Bun bundles the authored
graph directly, including the Iroh JavaScript loader; binary construction and
support discovery do not prepare workspace dist. Server support owns generated
Prisma clients, query and migration engines, Sharp assets, and the exact-target
Iroh addon with its package metadata. The server Sharp projection resolves each
package from its actual consumer, including the server's installed Sharp version
for foreign-target acquisition, then stages one adjacent native/libvips cohort.
The Bun server builder selects Sharp's public CJS entry and redirects only its
actual native addon import to that staged file. Sharp retains its own platform
selection, CPU checks, and error reporting; package-JSON autoload stays disabled.
Optional foreign-platform native imports stay virtual until selected at runtime;
guarded libvips resolution hints remain external so unselected platform libraries
are not embedded in the server executable.
The thin CLI continues to load its physical source graph and uses its existing
runtime dependency vendoring and target acquisition owners.
Only the thin CLI launcher enables package-JSON metadata loading so the physical
graph can resolve exports-only native packages beside itself. CLI dotenv and
bunfig autoload remain disabled; working-directory package metadata does not
replace the physical importing package's resolution authority.
Standalone compiler defaults come from `DEFAULT_BUN_COMPILE_OPTIONS` in the
existing compiler owner. The ordinary compiler and both Sharp/Prisma build
adapters disable implicit project `bunfig.toml` loading, preventing local preload
scripts from running before the tool starts. Dotenv policy remains separate.
Server typechecking and public npm/SDK declaration tasks remain separate.

Explicit web artifact construction and source QA share
`build_source_web_ui.mjs#withSourceWebUiInputs`. It compiles authored plugin UI
through the SDK compiler and existing inventory generator into private inputs.
Preparation first captures the authored UI, workspace and build-tool inputs via
the source build owner and existing `captureBuildInputFiles` primitive. Plugin
compilation and finite Metro exports consume that same copied input view;
additions, removals and edits in the live checkout belong to the next build.
Installed external dependencies keep their existing lifecycle. This is build-input
consistency, not a release snapshot or certification. Interactive Expo keeps
reading live source. Preparation
then supplies that inventory to Metro through
`HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY`. Expo exports browser code and assets
through the existing project-local staging and final-output owner. This source
path does not prepare workspace dist or public declarations. In 0.3 development,
ordinary Expo uses that same source plugin-UI compiler and inventory generator
without the finite-export input capture. Each consumer publishes its own inventory
atomically, referencing verified content-addressed assets beside that inventory. Managed Expo uses
its existing isolated state directory; standalone Expo uses `apps/ui/.expo/hstack`.
Other source preparations and exports never rewrite that consumer's inventory.
While serving source, Metro's existing batched file-map changes trigger that
same producer for bundled-plugin and compiler inputs. The workspace input
owner supplies source/dependency membership, including added source files;
generated inventory assets do not trigger another preparation. Pending edits
share serialized preparation. The inventory producer materializes each distinct
plugin byte graph once, using the canonical file-set digest, and does not rewrite
unchanged assets. Completed or failed compiler invocations remove their own
`.happier-plugin-ui-stage-*` scratch, including generated tooling and temporary
manifests. That existing staging prefix is excluded from Metro's crawl, so
retiring it cannot race Metro's fallback directory watcher.
Live refresh materializes the candidate's verified assets under the consumer's
content-addressed `artifacts/` root after Metro's initial watcher is ready. The
inventory producer assembles each first missing subtree under the excluded
staging prefix and renames the complete subtree into place. This prevents the
fallback watcher's directory-listing/watch-attachment gap from losing newly
created descendants; existing identical files retain their paths and mtimes.
Admission checks file existence, lexical and real project/watch roots, blocklist
and indexed extensions before waiting for Metro's file map. An
unindexable candidate reports `plugin_ui_inventory_unindexable` with its inventory
and asset path, preserves the serving inventory and releases the refresh queue
for subsequent source edits. An admitted candidate waits on Metro's existing
file-map change events until every asset is indexed before atomic publication.
Bundle and artifact-asset requests also use that readiness check for inventories
published by warm-start or explicit one-shot preparation, including Expo's
`/assets?unstable_path=...` route. Ordinary image requests do not read the plugin
inventory. There is no polling or new deadline.
Older browser/native bundles can request their asset URLs later: Metro 0.83 reads
those files on request, and an inventory swap does not acknowledge that every
client has retired its previous graph. Distinct served graphs therefore remain
with the consumer's state, whose lifecycle owner decides when it can be retired;
they are not reclaimed by a guessed age or generation count. This does not retain
compiler scratch or duplicate identical graphs. The listener and any pending
indexing wait end with Metro.
An already-running Expo must first load this
configuration at its owner's chosen restart; merely restarting a borrowing
server or daemon does not update the Expo configuration or its inventory.
To explicitly refresh an existing consumer without restarting Expo, run
`HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY=<absolute-inventory-path> node apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs`
from the checkout on the Expo-owning machine (PowerShell: set that environment
variable before invoking the same Node command). This is the normal source
preparation owner, not package dist construction.
When a new Metro consumer has no private inventory but the producer has usable
last-green plugin UI, the same inventory producer seeds the private file with
absolute references to retained artifacts. Metro starts from that file while
source preparation runs in the background and observes its next atomic green
publication without a restart. In 0.3 development source, a plugin manifest
evaluation or UI compile failure reports that plugin's error and retains its own validated
last-green artifact. Without usable retained bytes, only that UI is unavailable;
healthy plugins still publish and source preparation continues. The existing
inventory producer validates retained manifests and complete file digests before
admission. Native source construction materializes those verified bytes into its
own retained output graph, or leaves the unavailable plugin's output root empty.
Source preparation loads each declaration through the existing source loader
inside that per-plugin boundary, so a malformed declaration cannot abort an
aggregate tool import. The graph's successful build-input record also retains
its manifest for this failure path; it does not authorize new source or skip
graph validation. Source-preparation diagnostics remain in Expo's log; neither
the app's byte inventory nor `hstack stack info` carries them.
The source daemon retains that inventory beside its emitted runtime. Its next
shared build feeds the selected incumbent inventory to the same compiler and
inventory producer, which revalidates the candidate graphs and copies admitted
bytes into the replacement's own plugin outputs.
Host preparation failures still leave the serving inventory available and report
the problem. Explicit package artifact publication remains strict.
Metro readiness requires the inventory and every referenced asset, not the CLI's SDK dist/materialization
record: Metro already resolves authored platform-specific workspace exports.
Stack dispatches dev/mobile to their component preparation owners before any
global workspace publication. Explicit package artifact preparation retains its
dist and declaration prerequisites.

In 0.3 development, dependency refresh inventories recorded pending source starts,
Stack runtimes, retained server/daemon processes, and Expo consumers of the
installed tree before changing dependencies. Pending/runtime registration uses
the existing dependency reader lease; the writer cannot miss a newly registered
consumer. A live pending start refuses mutation with
`HAPPIER_DEPENDENCY_STACK_START_IN_PROGRESS` before dependency admission is withdrawn;
retry after its service readiness check completes. Runtime-state publication
keeps that same pending marker until readiness or failure cleanup. Worker source
tests and typechecks wait for a foreign pending start, releasing both dependency
custody and its writer-priority ticket before awaiting that existing transition.
They recheck freshness under the original lock afterwards. An owning start
retains the explicit refusal rather than waiting for itself. Running
runtimes and retained server/daemon processes do not block refresh or retain an
indefinite reader lease. After a successful refresh, output and dependency
readiness record their Stack names as `stacksNeedingRestart`; owners restart
those Stacks at their next boundary.
The consumer barrier lives in `apps/stack/scripts/utils/proc/dependency_consumers.mjs`.
It may stop only Expo consumers
owned by the calling Stack, using that caller's identity. A serving consumer
owned by another Stack rejects the refresh with
`HAPPIER_DEPENDENCY_METRO_RESTART_REQUIRED` before any consumer is stopped or
dependency admission is withdrawn. The owning Stack must be stopped explicitly
before retrying; discovering its PID state does not grant termination authority.

In 0.3 development, startup automatically refreshes stale dependency inputs
through `ensureDepsInstalled`. The existing dev reload coordinator also admits
dependency refresh before component builds when manifests, the lockfile, patches
or declared install inputs change. When no pending start uses that installation,
only the calling Stack's Expo consumers pause during
mutation; their existing supervisor resumes them when mutation completes.
A pending start or foreign Stack's Expo consumer blocks mutation: development warns and continues with installed
bytes, retrying on the next input change or startup. Explicit skip/disable refresh
flags and service-mode refresh permission retain their existing semantics.
In 0.3 development, `hstack dev` admits each component's runnable last-green
output before refreshing current inputs, including with `--no-watch` (one
background refresh). Server-only admission validates only the server's retained
payload; an unavailable CLI/plugin publication or another producer's publication
lease does not veto it. CLI observers discover inputs without enforcing the
bundled-dependency publication contract; that validation stays in the background
build. A cold component's startup failure is reported without exiting the runner
or stopping available siblings. Infrastructure, authentication, ownership and
output integrity remain prerequisites for the component that needs them.
Development server startup and reload use the existing retained source-runtime
builder when a compatible native snapshot is unavailable. Server code and its
first-party dependencies are captured and emitted together; startup does not
combine moving server TypeScript with older workspace dist. Atomic selection
pins the completed graph, so startup reads it without waiting on publication
custody. The existing server reload coordinator builds replacements in the
background and owns readiness and process activation. These development builds
reuse protected local jobs placement and dependency custody, without entering
validation's capacity queue or the shared CLI dist publication lease. A first
startup without retained output still needs a cold build. Retained startup and
availability recovery do not replay an older migration ledger; current source
replacement remains the migration owner.
Source QA uses the same startup admission policy, including nested compiler
leaves. A warm start reads the retained role without producer custody and prepares
current source through the existing pending-start owner in the background. That
preparation preserves the QA selection; explicit reload checks and activates the
replacement. Retiring the Stack cancels its background preparation. Cold roles
still need their first build, while ordinary validation keeps capacity admission.
The automatic refresh reapplies and verifies installed patches. Metro can serve
installed bytes and its retained source inventory while those inputs move or
another Stack prevents refresh. Missing packages
and broken source fail the importing bundle rather than stopping Metro. Its dev
supervisor keeps retrying exits and failed starts with the existing capped backoff,
and replaces an unresponsive owned process using Metro's existing readiness budget.
Until the heap leak is resolved, the supervised main isolate recycles at 90% of its
configured old-space limit, after all HTTP requests complete and its listener stops
accepting work. It logs the observed heap, watermark, limit and restart reason.

Dependency identity includes manifests, the lockfile, patches and installation
tool inputs. In 0.3 development, root and workspace manifests contribute their install
fields and install lifecycle scripts; exports, main/types and unrelated commands
do not require reinstallation. Root lifecycle inputs also include `prepare` and
`prepublish`; declared tool inputs remain whole-file inputs.
Raw-only v6 admissions still prove unchanged manifest bytes;
a changed raw-only manifest needs its admitted contents or an owning refresh to
establish the projected install inputs safely.
Authored UI/Protocol source is excluded: generated password/atmosphere
workers and WebView bundles own their source compilation and retained files.
Dependency-only postinstall skips those compilers. UI source preparation reuses
the existing producers; development may retain usable prior files with a diagnostic,
while strict source asset preparation still rejects compiler failures.

Local validation uses the dependency owner's read-only readiness check. It returns
`HAPPIER_DEPENDENCIES_NEED_REFRESH` for stale or incomplete installed dependencies
or an active installer, without installing, repairing patches or joining the
mutation queue. Worker mirrors retain their explicit remote bootstrap. Dependency
lock waiters, including Expo startup, report the holder through the existing
workspace wait notifier; a live installer retains ownership until it exits.

In 0.3 development worker mirrors, pnpm readiness also proves a clean root
installation. Earlier input-only admissions cannot prove that pnpm removed
unrecorded Yarn-era packages. The existing refresh writer therefore replaces an
unproven root `node_modules` tree before its canonical installation, without
following workspace links into source-owned private dependencies. The same
readiness record binds that proof to the pinned package manager and produced
`.modules.yaml`; missing or changed metadata or a Yarn integrity file invalidates
it. Unchanged proven installations stay warm, and adoption cannot certify an
unproven worker tree: worker adoption only rechecks readiness under shared read
custody. Actual worker installations also run the existing server-generated
client producer before publishing readiness, because root replacement removes
Prisma output. Source server preparation also calls that producer before capture
or compiler read custody, including after schema-only changes. The server's
`generateClients.ts` owns schema stamps, required outputs and patched private
runtime freshness; Stack delegates checks and repairs to it. Healthy checks share
read custody; stale clients regenerate under the dependency writer without
retiring loaded servers. Primary validation checks freshness and refuses stale
clients without generating them; explicit preparation performs the repair.
Producer failure withholds readiness. On workers, schema synchronization is
check-only and generation does
not access the database. This does not add a continuous inventory of manually
copied packages or change primary checkout validation's read-only policy.

Finite source runtime, web and workspace-package construction reuses that same
dependency lock through capture, consumption and cleanup. Dependency custody
participates in the native owner's joint admission with publication scopes;
capacity waits release those scopes before waiting. Admitted descendants reuse
their containing build's custody. Stack preparation does not hold dependency
custody while queuing its compiler children. Warm scriptless output repair
preserves an existing full admission when it does not extract dependencies.
Finite exports and read-only verification share dependency custody concurrently.
Queued refresh writers block new independent readers and run exclusively once
all active readers finish, in FIFO writer order. Healthy Stack startup verifies
installed admission under shared read custody instead of requesting mutation
merely to prepare component outputs.

In current development source, source exports, web artifacts and release web
archives share `apps/stack/scripts/build/precompress_ui_web_assets.mjs` for
Brotli/gzip sidecars. It compresses JS, CSS, HTML, JSON, SVG, WASM and source maps
only when the encoded bytes are smaller. Export owners complete compression
before returning or publishing the directory. The server's `enableServeUi`
negotiates those sidecars for static assets, including exported HTML files,
varies on `Accept-Encoding`, and serves identity when no accepted sidecar exists.
Dynamic SPA entry responses retain the server readiness marker and identity
body used by Stack readiness checks. HTML retains `no-cache`;
asset cache rules and the existing absence of ETag/Last-Modified validators are
unchanged. Compression happens at export time, not in the request path.
The full managed-infrastructure `ui_gateway.mjs` forwards UI requests to the
configured backend, preserving paths and headers. `buildServerRuntimeEnv`
configures the backend's UI directory and mount; the gateway has no separate
file-serving policy or `--ui-dir`/`--no-ui` configuration. `enableServeUi` owns
sidecar negotiation, SPA readiness, cache and security headers at both ingresses.

Metro resolves workspace code from explicit authored package exports. Nested
`browser` or `react-native` source targets take precedence over the portable
`happier-source` target, preserving the package's platform implementation.
Resolution does not infer source paths from `dist` filenames or rewrite absolute
dist imports. Public default exports still select package outputs.

First-party JavaScript, JavaScript sidecars, plugin resources and UI package files
belong to code. Target-specific external/native dependencies, tools and Go payloads
remain support. Support contains `node_modules` and `tools`; JavaScript sidecars
and source-derived plugin failure diagnostics remain code-owned. Stale checkout
publication failures neither select static support nor replace the code build's
private diagnostics during support linking.
Native construction does not require a prepared workspace-publication signature
or a copied CLI source generation. Source-resolution, syntax and bundler/process
failures abort construction; typechecking remains separate validation. Release
automation still owns self-contained target binaries, native assets and checked
public package declarations.

The bundled-plugin generator reads authored source for ordinary projection writes
and checks. `--mode check --scope projections` validates the semantic projections;
it does not compile a workspace dependency graph or prepare installed plugin runtime
bytes. Ordinary writes publish the source-owned projection set through that same
writer. There is no generator completion record, private compiler orchestrator or
prepared Agent-facts child protocol.

In 0.3 development, captured daemon source builds add `--daemon-projections` to
that check. This selects the generated locator table and normalized manifest
assets consumed by `readCliSourceEntries`, including runner leaves derived from
real authored Agent registration. UI, Voice, locale and Agent catalog projections
remain covered by the full semantic gate. The daemon selector is check-only and
does not repair captured inputs or publish package artifacts. Its captured
declarations share one inspection process and module graph for that invocation;
full publication retains per-plugin inspection processes.

Aggregate final-artifact publication deliberately reads serialized plugin declarations.
Both authored and serialized inputs must validate before replacing semantic membership;
invalid declarations fail visibly and leave the prior projection intact. Optional
runtime-preparation failures remain governed by the existing publication policy, not
silently reclassified as invalid semantic inputs.

Repository source tools run with the source condition and shared registration leaf:

```sh
./apps/stack/bin/hstack-exec -- node --conditions=happier-source --import ./packages/cli-common/registerSourceRuntime.mjs apps/cli/scripts/build-owned/generateBundledPluginEntries.ts --mode check --scope projections
```

The registration leaf loads the TypeScript adapter and registers the canonical
workspace source resolver before the tool entry is linked. In current 0.3
development it selects tsx's in-process transform cache before loading the adapter:
long-lived Stack controllers must not each enumerate and retain the shared tsx
disk-cache directory. This preserves ESM and CommonJS source transforms without
requiring cache deletion or changing installed runtime artifacts. Public/npm preparation
explicitly requests `--package-artifacts` when installed plugin manifests and
runtime bytes must be materialized. Its workspace compilation and strict declaration
checks remain owned by `buildSharedDeps.mjs` and the package-build owner, not by the
projection generator.

Stack's database environment and retained-data helpers import the existing storage
configuration and Personal Home layout leaves directly, keeping unrelated Home
activation and account-schema graphs out of long-lived controllers.

All workspace/package publication that shares the CLI dist path uses the canonical cli-common lock implementation. Development waiters continue while an authenticated owner's heartbeat is fresh, even beyond the elapsed contention budget; the existing staleness policy governs owner recovery, while unknown or unreadable owners still have a bounded wait. Nested build processes inherit an owner-authenticated lease containing both the normalized path and a random owner token; a path alone never proves ownership and cannot bypass a successor process. Publication and the prepared consumer that reads the published graph are one locked transaction: reconciliation replaces the dependency tree entry by entry, so a compiler, API-surface, or prepack reader released early could resolve one module from the new generation and its import target from the previous one. The prepared consumer therefore runs inside the same held lock and receives that lock's lease, which is what lets a prepared script that republishes the graph itself — `prepack` — reenter instead of waiting for its own owner. Dependency builds preserve that lease but remove the parent package's staged-output override so one workspace cannot compile into another workspace's publication directory. If compiled cli-common helpers are unavailable during bootstrap, the repository sync script stages and vendors a complete package off-path before publishing it, and propagates failures without modifying the previous live package.


Package admission and staged compiler publication validate all exported runtime
entrypoints in one local-import traversal. Shared modules are read once per
validation, rather than once per export. Each admission and retry starts a fresh
traversal so missing imports, changed output and recovery remain observable;
visited state also terminates cycles without an arbitrary graph-size cutoff.

The stack pack sandbox copies the shared workspace scripts, materializes the complete internal build-tool workspace closure, and links the repository's installed root dependency tree for external build-tool resolution. Build-time workspaces remain separate from the package's declared runtime bundle closure, so tooling-only packages cannot leak into the tarball. The root dependency link is outside the packed package root and is removed with the sandbox.

`packages/support` is the library precedent for this pattern. `packages/plugin-sdk` follows the same doctrine: its packed tarball bundles the internal workspace closure needed by its public declarations and runtime helpers.

## Source, managed-runtime, and release boundaries

The same source tree serves four deliberately different policies:

The live/artifact workspace publication modes described above concern package source outputs and
their dependency closure; they are not managed runtime-snapshot publication.

In current 0.3 development, Stack daemon commands execute the launch command
admitted by the runtime snapshot, including profile reconciliation before startup.
A snapshot's separate Node entrypoint remains available for bundle-closure inspection
and provenance; it does not replace an admitted native launcher. Source launches
without an explicit command still use the managed JavaScript runtime.
CLI launch-context resolution, including Stack auth, follows a matching live
Stack owner's recorded source basis before persisted runtime-mode defaults.
If a source daemon has already loaded that basis, a missing retained CLI
fails closed rather than rebuilding different source for the running stack.
Explicit `--runtime=built` requests still validate the built snapshot, and
deployment selection does not inherit this implicit CLI-mode decision.
Explicit-runtime Stack start, daemon lifecycle and CLI commands consume their
admitted snapshot without first preparing the moving source workspace. Source
commands retain the existing workspace preflight.

Controlled daemon-only workers consume their forwarded Home through the same
server-connection owner as source development: `--no-server --server-url=<url>`
does not resolve, start, adopt, or probe a local server database. Runtime admission
still requires the worker's daemon artifact; it does not require a server component
that runs on another host.
The controlled worker retains foreground custody after detached daemon startup,
including adopting its own already-running daemon through the existing lifecycle
owner. It records loaded runtime identity without forcing a healthy matching daemon
to restart, and the existing signal/shutdown path releases that custody.

Detached daemon launch from an admitted JavaScript closure runs the existing
managed JavaScript-runtime bootstrap before resolving that child, including when
the foreground launcher is native. It retains the admitted closure rather than
reusing an unrelated incumbent runner or requiring system Node.
Subprocess executable resolution uses the same requested environment as closure
admission, including its Happier home and explicit runtime selection; a detached
or successor launch does not borrow the parent's runtime selection.
Bundled-plugin custody also recognizes a Stack snapshot's daemon artifact. The
CLI custody owner resolves the snapshot's `cli` link to the physical
`artifacts/daemon/<fingerprint>/payload` root and binds its identity to the
producer manifest's component, payload directory and artifact fingerprint.
Native and JavaScript launches share that exact artifact identity. Managed
installation pointers retain their canonical version-marker checks; Stack
artifacts do not require or manufacture managed-install markers.
On Linux, Stack's listener observer prefers the kernel socket table (`ss`) for
exact-port PID evidence instead of scanning process files with `lsof`. Existing
ownership verification remains authoritative; missing process identities are
inconclusive. Process-group probes and hosts without `ss` retain `lsof`, and
Windows retains its `netstat` adapter.

- Source validation reads authored source and checked-in/generated compiler inputs. Typechecks, ordinary tests, lint, and searches do not publish CLI, server, UI, daemon, plugin, runtime-snapshot, or runtime-support artifacts.
- Source development starts from any valid last-green output when one exists, then refreshes changed source outputs through the existing service reload owners. Source startup, reloads, UI preparation and remote readiness do not request native runtime publication. Explicit artifact/build commands own that separate path; publication and selected/loaded runtime identities remain unchanged by source reloads.
  In 0.3 development, `ensureWorkspacePackagesBuilt.mjs` owns startup admission:
  an intact recorded dependency closure admits a source server before refresh;
  cold or damaged outputs still require preparation. Daemon import probes and
  Expo's atomic source inventory describe their own runnable outputs to the same
  startup policy. Server and daemon refresh/restart stay with the existing reload
  coordinator; Expo refreshes its inventory in the background. Strict/artifact
  preparation continues to await checked current output. Cold watch-mode source
  failures retry when their affected inputs change; configuration and OS failures
  abort, and cancellation closes the preparation watcher. Finite
  `stack start --runtime=source` QA bundles resolve authored source directly and
  have no workspace-dist startup gate; their explicit reload boundary is unchanged.
- Managed named-stack publication probes the existing component source/toolchain identities and artifact manifests before bundled-plugin preparation. When every selected web/daemon artifact matches, bundled-plugin preparation is skipped. A web or daemon miss uses the canonical selected preparation closure and then recomputes identities after generated-input writes. Publication builds only the requested runtime component(s), reuses unchanged component artifacts and owner-specific support artifacts, and commits a complete runtime snapshot whose component paths reference canonical producer payloads. A consumer selects that snapshot; it does not build or copy a second payload, and selection does not restart a running process.
  Daemon-only preparation retains plugin-owned UI artifacts distributed with daemon code, but does not generate the UI application's app-preseed registry. The web consumer owns that registry; combined web/daemon preparation still generates it once.
  Web identity includes the projection producers and their build inputs. The bundled-plugin generator owns its authored-source closure, including esbuild-resolved transitive imports; web identity consumes that closure, while daemon code resolves its source entries through the shared source runtime owner. Reuse admission checks payloads through the manifest owner: entrypoints must be non-empty files, web requires existing local assets referenced by its entrypoint, and declared component support must resolve. Builders, admission probes, latest-artifact selection and snapshot construction/selection share that check. Missing daemon support is repaired through its existing builder. Historical physical or retained self-contained snapshot components share payload health without requiring a current support binding; a rejected live canonical reference cannot fall back to historical reuse. These checks detect incomplete payloads, not arbitrary byte corruption.
- In current development source, daemon code is bundled directly from source.
  Its independently reusable support artifact contains target-specific external
  runtime packages, tools and Go payloads, not a copied first-party JavaScript
  dependency frame. JavaScript sidecars and plugin resources/UI package files stay
  with code. Component manifests bind code to the admitted support reference.
- Release/self-host packaging remains the existing per-target direct boundary. Each target builder materializes its target's complete self-contained component/support payload from settled component inputs; it does not consume or flatten a host-target managed snapshot. The resulting package must not depend on the checkout's `node_modules` or a system package manager.

In current development source, explicit artifact builds enter the component build owner's admission directly,
without a competing launcher-wide workspace publication. Requested components' preparation failures are
recorded in the producer's existing `runtimePublication` projection. Queue and lock-wait progress uses stderr,
including with JSON output. Native component builds commit a complete snapshot by composing
their built artifacts with the target's current unrequested components and return `snapshotId`.
Publication without activation preserves every stack's selected runtime, including the producer's
native pin. Composition validates component payload/support closure, execution target and
server flavor; component generations need not share a whole-checkout source fingerprint. Initialize a
native target with `--all` if it has no complete snapshot yet. Explicit foreign-target server-only builds
can publish a server subset without fabricating web or daemon artifacts. Service-specific consumers
validate the required subset; default admission still requires all three components. The consumer adopts the publication through
`stack runtime <consumer> select`, with no rebuild; other consumers use the same command. Selection
and publication do not restart services. `--activate-runtime` selects the requesting consumer
and the matching native producer snapshot.
Explicit `runtime activate` discovers stored artifacts under producer admission and delegates composition
to the same `publishBuiltRepositoryRuntimeSnapshot` owner; its launcher does not prepare source workspaces.

Explicit built-runtime requests build only their requested components. Native AUTO
owns mirror synchronization, tooling readiness, target capability and worker memory
admission; compilation reads the selected worker's source checkout. There is no
source capture/upload, retained target build checkout, publication flight, merged
demand or persisted start sequence. Source development and default source QA do
not request native publication.

The producer's optional `runtimePlacement.build` remains build-placement policy.
Worker admission and compilation run outside the short producer publication lock.
A worker constructs a private final artifact store; a remote worker returns that
validated artifact closure through the existing transfer owner. Only final outputs
are staged/transferred. The producer imports them and commits the snapshot through
the existing short publication transaction. A dispatched build failure is reported,
not replayed locally.

Requested components' terminal outcomes remain in `runtimePublication`.
Publication without activation preserves every stack's selection. Explicit
activation/selection continues through the canonical snapshot owner; neither
publication nor selection restarts a running service.

Complete snapshot selection and retention are target-aware,
and a foreign-target publication does not replace the producer's native current pointer.
Server and web builds can use a worker of another operating system or architecture through their explicit target-aware builders.
Server support installs the exact installed Sharp version with npm's CPU/OS selection in an
isolated target dependency tree, while Bun and Prisma use their existing explicit targets.
Linux x64 workers can also build Linux ARM64 daemon support when npm, Python, make and the
`aarch64-linux-gnu` C/C++ toolchain are available. The CLI support owner acquires target runtime
packages in isolated npm CPU/OS-selected trees, cross-builds node-pty through node-gyp, and
runs FFmpeg's installer with its target architecture. Host build dependencies remain native.
The existing finalizer projects esbuild, Iroh and bare prebuilds as well as PTY/Sharp onto the target.
Other daemon cross-target pairs still require a matching native worker. The shared support-target
admission owner reports missing cross prerequisites before dispatch.
Finished payloads return through the shared runtime artifact closure
transfer, existing manifest validation and producer retention, then ordinary snapshot publication.
Transfer archives are staging files, not retained runtime artifacts. Downloaded
final artifact archives and private stores are released after import. Remote
cleanup failures remain visible without replacing a build failure. Controlled
snapshot uploads retain the same cleanup owner, including partial upload failures.
The worker's source mirror, installed dependencies and package-manager cache remain
with their existing owners; native builds do not create another retained source
checkout. Worker disk admission and custody-safe reclamation remain at their
existing owner.

Unavailable or incompatible workers are excluded visibly before compilation dispatch. A busy worker's
actual host-global request stays queued against OS available memory and unused live class reservations, while
no-wait alternative attempts use that same admission owner. The original waiting request is released
only after an alternative has actual admission. No admission-check preflight or busy result authorizes
local compilation. A dispatched build failure is
authoritative and is not replayed locally. WSL uses the POSIX transport; native Windows remote build
placement is not supported. These native publication rules apply to the explicit built-runtime option,
not the default source QA path. In 0.3 development, new QA stacks use `source-snapshot`:
the existing supervisor flushes each executing host's mirror, then `run.mjs` directly bundles server
or CLI code with explicit first-party source exports and starts managed JS without watchers.
Bundling has no workspace dist/typecheck, publication flight, demand, archive-transfer or native
snapshot-selection prerequisite. Installed dependencies and target-native support remain host-owned.
During initial source-snapshot preparation, source compiler and Metro drift failures are reported
and keep startup pending until affected inputs change. Runtime bundles and the web export share
the development reload coordinator's classification and observation; configuration, dependency
admission and OS failures still fail fast. Cancellation releases the pending preparation.
Source CLI bundles also carry the public author SDK's JavaScript and declarations in a
private, bundle-owned package closure. The source-runtime producer uses the existing
compiler and workspace materializer with the source condition, without preparing workspace
`dist` or requiring semantic typechecking. Plugin authoring resolves that physical closure;
the CLI's source-runtime provenance and published SDK contracts are unchanged.
Development TSX subprocesses select `apps/cli/tsconfig.runtime.json` through
`resolveCliTsxTsconfigPath`. It retains the compiler project's strict options but
limits path aliases to the CLI's source alias: compiler-only SDK declaration
aliases must not override the workspace packages' executable source exports.
Build-owned source generators consume that same runtime configuration. This
does not change packaged binary execution or compiler selection.
The shared source-input inventory captures each consumed workspace package's
authored `files` entries, including README/API documentation and resource directories.
The strict workspace copier consumes those captured bytes; generated `dist` remains
the current source-emission owner's output, never a checkout capture input.
An explicit restart prepares current source. Stacks on the same host reuse a read-only
bundle when its source/tool cache fingerprint, captured esbuild bytes and compiler-reported
input versions still match current source.
The shared build-input inventory owns fingerprint membership; the bundle's emitted-code
hash owns runtime identity. Bundle directories are private allocations; their
fingerprint prefix binds producer custody, not runtime identity or proof of captured
input bytes. Edits during preparation do not reject successful output; a changed cache
fingerprint prevents reuse, and captured input digests also reject stale reuse after an
edit followed by Undo. This is a finite bundle of the bytes read, not an atomic checkout
snapshot. Unchanged reuse takes fingerprint and short publication custody before
heavyweight admission, so it needs no compiler-memory reservation. Cold producers
share a lock for their input fingerprint; different fingerprints can compile
concurrently under the existing host-memory admission owner. Retention uses short
JSON-metadata publication custody, not a compiler/workspace lease. The sole
selection writer runs only after completion and read-only conversion succeed;
failed construction or publication preserves the previous coherent selection.
Stack-scoped CLI commands reuse an existing daemon selection, including a graph
selected by startup before its UI export or daemon launch completes. A CLI command
bootstraps current source only when no selection exists, rechecking that condition
under publication custody before selecting its result. An unavailable selected
graph fails closed and requires an explicit restart to select current source.
Fingerprint custody stays held through publication. Retention protects active
unfinished graphs and reclaims abandoned fingerprint-bound allocations on a later
publication; old unfinished allocations without that custody binding remain
conservatively retained. If a queued launcher crosses an admission-protocol cutover and its
child reports `HSTACK_WORKSPACE_ADMISSION_ORDER`, source preparation lets that
attempt exit and release its workspace lease, then re-invokes the complete joint
producer through the current admission owner. A second refusal remains fatal;
native helper staging shares the admitted source-bundle envelope.
Source bundles use the measured 10 GiB worker envelope;
web preparation/export keeps its separate validation envelope. A newer pending source start
supersedes only that stack's previous pending start. The bundle owner retains live/selected
bundles plus the newest completed product (using its immutable completion record,
not allocation-directory timestamps), and reclaims unreferenced bundles when process visibility is available
(native Windows currently retains them). Emitted code remains unchanged between restarts. The existing
server also serves a finite source web export by default. Same-host Stacks sharing
the configured source-products store reuse completed read-only web bytes when authored
captured inputs and effective build options match and the complete exported payload
still validates. A hit performs no Plugin UI/SDK preparation, Metro export or
precompression. A cold producer uses the existing joint capacity/workspace admission
owner and pins completion in its caller's pending-start marker before releasing its
build lease. Pending, selected and serving references share source-bundle retention.
Explicit executable app-local configuration outside the authored capture uses private
finite preparation instead. Expo cache/state uses the stable Stack source root;
Metro retains its physical-project-root cache partition for route correctness. The
server reads through a Stack-owned serving link, so a web-only reload can select a new
export without changing another Stack's shared bytes. No Metro process or hot reload remains. `--ui=borrowed`
explicitly uses the configured moving Expo producer instead; its presence in the environment alone
does not select it. `--no-ui` keeps a source worker headless. Code preparation precedes the UI export,
and one-shot bundlers release their services rather than retain idle heaps in the Stack lifecycle owner.
For a running source Stack, `hstack stack daemon <name> restart --runtime=source`
prepares current daemon/plugin code on its observed host and replaces only that daemon.
The existing daemon lifecycle owner retires the incumbent before selecting and attesting
the successor; recovery consumes that canonical selection instead of stale runner arguments.
`hstack stack build <name> --web --runtime=source` prepares only the web export and
publishes the validated export through the existing directory-swap owner at the server's
retained UI path. Current source starts swap their Stack-owned serving link; an older
loaded Stack with a private serving directory keeps its path-based publication until
explicit restart. Server and daemon processes remain running during a web reload;
failed preparation leaves the served export available. Reload the browser after publication.
These commands reuse the synchronization/SSH and source-build owners, without selecting
native artifacts or restarting the complete Stack. Borrowed Metro retains its live reload path.
`stack.runtime.json` projects each role's selected/loaded source-code identity, and loaded identity
is meaningful only with actual service/custody readiness. Daemon startup, including manual
post-auth startup, attests the retained bundle at the shared launch owner after that exact
entrypoint starts successfully. Merely adopting a healthy daemon does not infer a loaded
source identity. In 0.3 development, the existing pending source-start marker also
projects preparation: `queued` while waiting for capacity or preparation custody,
`building` only once the finite producer is admitted, and `checking` during reload
smoke validation. `stack info --json` exposes `runtime.sourcePreparation`, including
independent remote-host phases during a reload; remote starts carry the same facts
over their existing worker stdout transport into `remoteTargets`. Final publication
after service readiness, or failure/cleanup disposal, retires the marker;
runtime-state publication alone does not. A dead requester supplies no active preparation.
An incumbent serving HTTP 200 remains degraded while its replacement prepares,
and selected/loaded identity agreement plus actual readiness is still required.
Preparation phases and selected/loaded identities do not replace service readiness
or runtime lifecycle ownership.
Controller CLI/auth uses its own retained
source bundle without replacing the remote role identities. Built QA uses `--runtime=built` and the
existing target-compatible selection instead. New `--qa`/`agent-qa-*` stacks request linux3, linux2 and linux1 through
their stack environment. The service-placement owner chooses the largest observed available-memory budget
after live reservations and persists one explicit daemon pin, because its Machine owns sessions, resume and
workspaces. Live Expo/browser/daemon RSS is already reflected in available memory. Add windows1-linux only
after its outer Windows C: disk is healthy; it is not a default candidate. Heavy validation remains on hosts
fitting its existing class envelopes, independently of this QA pool.
Existing stacks retain their placement until their owner explicitly changes it at the next restart.
QA and command pools cannot override that pin. Shared-db presets preserve the consumer's daemon choice.
Remote retirement accepts an unreadable runtime record only when its last write predates
the host's current boot; that prior process lifetime cannot survive the reboot. Unreadable
current-boot records still fail closed, and readable records retain the canonical process
ownership checks. Runtime identity probes report structured missing, empty or invalid
state errors with the exact state path and Stack recovery action.
The existing supervisor connects a daemon-only worker through its existing reverse forward.
Only built mode transfers the selected native per-service closure. An unavailable pinned daemon host
stays on its assigned target and retries through the supervisor's existing lifecycle backoff.
Synchronization status/flush, daemon preparation and tunnel failures leave independent local
server and UI services available while that target recovers. The borrowed synchronization
project remains owned by the independent sync service. A newly opened reverse forward gets
its initial readiness retry; if the reused forward still fails after the controller server
is ready, the supervisor replaces that owned transport through its existing lifecycle backoff.
Recovery reuses the retained source runtime selection and reruns daemon readiness.
Remote server/data admission still
fails closed when the retained-data placement contract cannot be established;
retained local server data still requires explicit handoff. The full split-host browser journey
remains unverified. Producing another architecture requires a compatible native/support
build, not relabeling bytes. Targetless predecessor snapshots remain host-local inputs rather
than proof of foreign-target compatibility.

Before a fresh source invocation publishes its replacement launch, the daemon retirement owner
captures recorded PIDs and discovers unpublished starting daemons by exact stack, CLI home and
daemon process kind. Retirement verifies process incarnation through the shared ownership owner;
sessions and other stack homes are excluded. Attaching to an existing outer Stack owner does not
launch another generation.

QA host provisioning reuses managed JavaScript/Agent installers and the existing browser, power and
disk-retention owners. The service-placement owner selects the QA pool host with the greatest
observed unreserved memory for each browser lifetime, independently of the daemon pin. It does not
write placement or fall back to the controller. The browser lifecycle returns an owned
forwarded CDP endpoint to the controller. A lane-owned loopback reverse SOCKS forward uses the existing
SSH transport owner to reach the controller's server and borrowed Expo ingress. Chromium proxies
loopback traffic through that route, preserving the original origins and canonical Home address even
after authentication adopts the Home descriptor. Temporary-port URL rewriting is not used. The foreground browser handle owns cleanup; it does not register another runtime
or copy user Agent credentials. Linux service memory observes daemon/browser process trees alongside
server/Expo trees for diagnostics. Their resident pages already reduce OS available memory;
admission reserves only the unused portion of admitted command envelopes.
Controlled artifact imports stage their closure on the destination Stack filesystem and remove that
owned staging directory on success or failure; system temp may be quota-limited tmpfs even when the
Stack store has space. Artifact admission and retained data are unchanged.
Dedicated QA-host browsers use `--no-sandbox` under the approved policy for Happier's own QA app.
The worker remains alive until its custody owner signals shutdown, including when payload stdin is closed.
Normal SIGINT/SIGTERM/SIGHUP shutdown requests `close` through custody's existing stdin control
channel and keeps the transport alive until `agent-browser close` and profile removal finish;
only then are the SOCKS/CDP forwards retired. Transport loss still uses remote execution's
process-group cancellation. A browser forward that disconnects after readiness restores its
SOCKS/CDP bindings at the same controller address. If it exits during a pending CDP readiness
request, the launcher reports the failure and requests worker cleanup so callers can restart.
A retained profile can be recovered on its original target through
`qa_browser.mjs --cleanup <session> <profile>`: the same worker cleanup owner closes that exact
session before removing its named QA profile beneath the target's temporary directory. A failed
close retains the profile and reports failure.

Codex's managed release recipe retains its native-file allowance and uses the plugin manifest schema's
512 MiB total expansion ceiling. The digest-verified `rust-v0.161.0` Linux package includes resources
beyond the installed executables and exceeds the former 384 MiB total. Digest verification, declared
runtime-member publication and the shared path/compression/extraction guards remain enforced.

In 0.3 development, the managed Codex Linux recipe also publishes the pinned
release's `codex-resources/bwrap` with executable permissions. Codex resolves
this bundled helper beside the package's `bin` directory when system bubblewrap
is unavailable; Happier does not require installing a system package for this
helper. Existing managed installs missing it need a forced reinstall through the
normal Agent install Action after the corrected declaration is loaded. Linux
hosts must also permit the user namespaces used by Codex's sandbox. macOS
and Windows keep their platform-specific package members.

Managed runtime support is component-owned, not a generic dependency-layer registry, and its references are a development/QA snapshot concern only. A server manifest may reference an immutable server-support artifact containing its generated Prisma/native closure; a daemon manifest may reference its immutable daemon-support artifact containing external/native runtime dependencies, tools and Go payloads; JavaScript sidecars and plugin resources/UI package files remain code-owned. The component builder computes and validates its own support identity. Snapshot validation follows those references, and retention follows the graph from retained snapshots through component artifacts to referenced support artifacts before deleting anything. Existing self-contained release/runtime artifacts remain readable until ordinary retention removes them. Release/self-host builders discover and embed their own complete target support closure directly.

Server support hashing and staging share the server-sidecar owner's membership rule. Workspace `dist/.happier-build-inputs.json` records are preparation evidence and are excluded from both: refreshing their timestamps or dependency fingerprints cannot invalidate unchanged runtime bytes. The workspace output owner defines the record filename; actual emitted code and native support still participate in support identity.

The managed server code artifact is independent of static web UI. Runtime launch supplies the selected web artifact through the existing `HAPPIER_SERVER_UI_DIR`/Stack UI-path owner. Borrowed Expo is a controlled-live development/QA UI provider; strict snapshot UI requires an explicit web artifact. Release and self-host builders may combine web and server into their own self-contained target payload, but managed server publication does not embed or regenerate web UI and release builders do not consume a managed snapshot.

## Dependency ownership

### Managed browser acquisition (0.3 development)

The browser source installs the protocol-pinned Chrome-for-Testing archive through
the CLI's `chromiumForTesting` projection and canonical pinned-archive installer.
It verifies the archive digest before streamed extraction and checks the installed
executable when resolving the source. System browsers are not substitutes for this
managed source.

Pinned Chromium executables exceed the generic extractor's per-file allowance.
This source reuses the extractor's existing total-expanded-byte budget for each
file; total expansion, entry/path admission, compression-ratio, and extraction
deadline policies remain enforced. This describes development source, not a
published-release guarantee.

On Linux, managed Chromium keeps its namespace/seccomp sandbox. If Chromium
reports `No usable sandbox!`, the launch owner checks AppArmor's
`apparmor_restrict_unprivileged_userns` setting and a real user-namespace probe.
When both establish the restriction, browser launch returns `sandbox_unavailable`
with the recovery action `happier browser sandbox install`.

Run that command on the machine that executes the browser. It reuses the managed
Chromium installer if needed, then performs one sudo action to install and load
an AppArmor `userns` profile attached to that installed executable's literal path.
In 0.3 development, agents can request the machine-scoped `browser.sandbox.install`
Action, subject to default human approval (waivable in Action settings). The daemon
uses this same installer with noninteractive sudo: Action approval does not grant
OS privileges. When sudo authorization is unavailable, the Action returns
`os_authorization_required`; run the local command with OS authorization and retry.
`--print` displays the profile for an already-installed browser without applying
it. This follows [Ubuntu's per-program user-namespace profile](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces).
The command does not restart services or change a global sysctl. A different
Happier home/executable path needs its own profile; run the command using the same
Happier home as the browser runtime. Retry browser open after installation.

### Optional CLI payloads (0.3 development)

Binary CLI packaging separates local semantic-memory inference, native voice
inference, and difftastic into the signed `happier-memory-runtime`,
`happier-voice-runtime`, and `happier-difftastic` components. The managed-installable
catalog exposes them for explicit installation and the real memory, voice, and diff
consumers acquire the packaged CLI's exact version on first use. Source CLI
and retained source-bundle Voice inference instead use the CLI's installed,
pinned Sherpa dependency through the same optional-runtime resolver, including
capability detection and explicit installation. The source package version does
not require a matching published CLI release. A validated
installed version can be reused offline; first packaged-component acquisition
still needs the release service. Local memory startup does not hold daemon readiness while downloading,
and disabling memory prevents late activation. When `deleteOnDisable` is enabled,
it removes late-written model cache after pending initialization settles. The shared optional-runtime download is not
aborted on behalf of other callers.

The CLI host omits its direct Transformers and Sherpa dependencies and bundled
difftastic tool. Dependencies declared by trusted plugins and SDK packages retain
their own closure. FFmpeg remains in the base CLI because both voice decoding and
browser recording consume it; moving it would make the non-voice recording path
depend on voice installation policy. Voice worker entrypoints, SDK declarations,
public author docs, examples, API and capability references, licenses, and
executable dependency source maps are retained. The public SDK packages'
generated governance records (`api-declarations.md` and `api-surface.json`, never
committed; the npm tarball gets them from `prepack`) are neither copied nor declared
by the workspace bundler, driven by one list in
`PUBLIC_SDK_GENERATED_GOVERNANCE_RECORDS` in `packages/cli-common/src/workspaces/index.ts`. The binary
finalizer applies the same list plus the Plugin SDK's release-governance `scripts/`
subtree, atomically removing those entries from each packaged `package.json#files`
inventory first. Target projection
removes foreign ONNX and PTY prebuild directories, preserves the selected native
sidecars and source-built PTY fallbacks, and removes the opposite platform's exact
PTY terminal modules and native source directories. The development CLI no longer
ships ps-list or its fastlist executables: Linux process observations use the TS
procfs census, while macOS and Windows use `process-census` in the existing native
process-custody helper. A missing helper makes the native census unavailable; it
does not fall back to shell process listings. The helper returns typed census rows
with start-generation, OS-principal, CPU and explicitly named memory evidence;
the TS census decoder is the shared reader boundary. Raw own-principal commands,
paths and owner markers remain daemon-private until the ownership projection
redacts authorized Happier rows. Windows owner-held Session/PTY Jobs use the same
shipped helper's one-shot `job-join`; session custody adds no resident helper and
does not enable kill-on-close. Managed-service/finite-PTY custody keeps its existing
holder. See [machine process ownership](cli-architecture.md#machine-processes-03-development)
for holder-death fallback and the one shipped tree terminator.
The finalizer removes only explicitly audited
nested dependency copies whose complete physical trees and permission bits match
an ancestor that Node will reach without an intervening package. Missing,
shadowed, or divergent copies remain; SDK declarations, licenses, and other
authoring files remain in the surviving tree. The audited 0.3 package closures
have no peer dependencies; a dependency update introducing peers requires a new
resolution audit before extending this list. The binary CLI's root `package-dist`
also drops its unused CJS build and declarations. Declaration maps and incremental
compiler metadata are removed from both the host and isolated components. Host dependency
declarations remain available for plugin authoring; isolated inference components omit their
unused declarations. Executable source maps remain available for Bun and Node diagnostics.
Runtime JSON, JS, licenses, and docs stay.

First-party acquisition reports phases and actual transferred bytes through the
existing system-task events. These samples are presentation data, not install
authority: unknown or malformed samples fall back to the normal task display.
This describes current development source, not a published-release guarantee.

The release verifier checks each optional component's signed checksum envelope and
uses the managed first-party extractor and catalog to validate entrypoints on every
target, including with `--skip-smoke`. Existing archive topology, metadata, and privacy
admission remains in force. Matching hosts also run `difft --version`, import the
Transformers Node entrypoint to construct an ONNX-backed tensor without downloading
a model, and import the Sherpa native entrypoint to verify an inference constructor.
`--skip-smoke` skips these optional executions; the matching base CLI still
has to attest both binary and Node-entrypoint versions, load the native command
catalog through `--help`, and run its isolated
MCP client/server, Sharp, and PTY runtime smoke. The smoke clears `NODE_PATH`, so
repository-hoisted dependencies cannot hide an incomplete archive, and it checks the
stable target-projection invariants, including absence of Transformers, Sherpa, and
the retired embedded voice archive/loader, the unused Claude Agent SDK, and
Windows-only PTY inputs.

Add dependencies to the package that imports them:

- If `packages/protocol` imports a library, add it to `packages/protocol/package.json#dependencies`.
- If `apps/cli` imports a library directly, add it to `apps/cli/package.json#dependencies`.
- Do not mirror protocol-only dependencies into `apps/cli` merely because CLI bundles protocol.

Bundled workspaces are copied into the host package and are not installed by npm as independent workspace packages. The bundler vendors their external runtime dependencies based on each bundled workspace's own `package.json`.

## Internal dependency closure

`bundleWorkspacePackagesWithRuntimeDependencies(...)` is the normal host bundling path. The lower-level `vendorBundledPackageRuntimeDependencies(...)` helper vendors external dependencies only and intentionally ignores `@happier-dev/*`; use it only when updating an already-published package tree independently is specifically required.

If a bundled workspace imports another internal workspace at runtime, the host package must also bundle that internal dependency. For example, a host that bundles `@happier-dev/cli-common` may also need `@happier-dev/agents` and `@happier-dev/protocol` if they are in the runtime import closure.

### One module instance for the plugin-shared runtime

Development source bundles resolve external support from the authored importer
before relocating code into shared chunks. The source resolver retains that
installed package version and its import/require export conditions, including
lazy imports; a root-hoisted package cannot replace a plugin-local dependency.
Native payloads retain their explicit support closure, while external installed
plugins bundle dependencies through the existing plugin authoring owner.

For public npm publication, the CLI's pkgroll build inlines its bundled internal workspaces into `package-dist`, except `PLUGIN_HOST_SHARED_RUNTIME_PACKAGES` (`apps/cli/scripts/pluginHostSharedRuntimePackages.mjs`: `@happier-dev/plugin-sdk` and `@happier-dev/protocol`). First-party plugin daemon bundles leave the same packages external, and the bundled-plugin generator reads the same list. Host and plugins therefore resolve one module instance of each from the shipped `node_modules` closure. An inlined host copy is a second instance: it duplicates the Protocol schema graph actually admitted by that runtime and gives host and plugin code different schema identities. Owner-level schema deferral reduces unused construction; it does not make duplicate identities safe.

Because these imports stay external, a `package-dist` whose workspace publication lacks an export it imports fails when the daemon links the module, not when pkgroll runs. The canonical build publishes the workspace closure before pkgroll and refuses a mixed closure (`build.mjs`).

In current 0.3 development, native construction emits host, first-party plugin and
child entrypoints together with esbuild's shared ESM chunks. Bun compiles only the
launcher; it imports the physical `package-dist/index.mjs` beside its executable.
The host and plugins therefore use the same physical shared modules instead of
an embedded host copy plus physical plugin copies. The payload carries that ESM
graph and its target support; execution does not require system Node or a package
manager.

## Adding a bundled internal workspace to a published package

When introducing a new `packages/<name>` that must ship with a published package:

1. Add it to the published package's `package.json#bundledDependencies`.
2. Add it to that package's `package.json#dependencies` with workspace version `"0.0.0"`.
3. Add it to the package's `scripts/bundleWorkspaceDeps.mjs` bundle list.
4. Update bundling and published-dependency tests.

For `packages/plugin-sdk`, source and integration validation must prove through the canonical governance and consumer fixtures that external consumers resolve only the supported public surface and do not require independently published internal workspaces. Do not create a local archive/install gate for feature completion; release automation owns the archive it publishes.

## Missing `dist` / invalid exports

Ordinary published package exports include `dist/**` targets. If `dist` is missing,
public package consumers can fail with invalid-export errors. Native construction
and source QA explicitly select `happier-source` and resolve authored entrypoints
through the shared source owner instead.

Fix by building the workspace, for example:

```bash
pnpm --filter @happier-dev/protocol run build
```

Public package preparation must build missing internal workspace outputs through
the package-build owner. Native source construction must fail on missing authored
inputs rather than preparing or falling back to dist.

In current 0.3 development, package and shared source-bundle publication jointly
acquire their existing leases and compiler admission through the native Stack
owner, rather than queueing a compiler while holding a dist lease or charging a
payload envelope while waiting for that lease. See [testing ownership](testing.md)
for the ordering and inherited-envelope contract.

`hstack auth login` and `hstack stack auth <name> login` dispatch directly to the
auth owner without first publishing Stack's workspace closure. The selected CLI
entrypoint still owns any missing CLI runtime preparation; that preparation
finishes and releases its build leases before importing login/pairing. The
interactive pairing wait does not own a workspace dist lease.

## Bundling sanity checks

In 0.3 development, CLI password crypto imports sodium through
`apps/cli/src/auth/passwordSodium.cjs`. Its literal require selects the package's
public CommonJS export in the source and esbuild graph. Externalizing that
require would let Rollup convert it to an ESM import, selecting sodium 0.7.16's
incomplete ESM export. The canonical CLI pkgroll preparation therefore inlines
this bundled dependency through the same mechanism used for bundled internals,
preserving its working CommonJS export inside the emitted ESM graph. Other
dependencies remain external; in particular, Ink's top-level-await modules
must retain async ESM loading. The canonical CLI binary code builder starts
the emitted `index.mjs` graph through its native launcher.
The physical ESM graph keeps module-URL `createRequire` calls relative to its
payload dependency tree. The focused crypto bundle test runs the self-contained
prebundle away
from repository dependencies and checks the canonical Argon2id/HKDF vector without
building the full CLI or requiring Bun in the unit-test environment. The installed sodium 0.7.16 ESM
wrapper references an absent sibling, so this boundary deliberately uses its
CommonJS export.

The daemon dependency owner test additionally runs canonical pkgroll preparation
and Bun's real resolver, then checks an async ESM dependency and the password KDF
from an isolated bundle without adjacent dependencies. It checks the bundle
failure boundary without building the full CLI or changing production compiler
limits.

When touching bundling or dependencies, run the relevant source-level script and dependency-closure tests. For CLI changes, the check should prove that protocol dependencies are projected under the bundled protocol workspace path, not duplicated at the host root unless the host imports them directly. Feature QA does not produce or install a local release archive.
