# Native E2E (Maestro) — `suites/mobile-e2e`

This suite contains **native** (iOS/Android) E2E flows executed via **Maestro**.

## Philosophy

- **Playwright remains the canonical web UI E2E** (`suites/ui-e2e`).
- Maestro focuses on **native-only regressions**: touch/keyboard/back/gesture/popup rendering.
- Selectors are **`testID`-only** inside Happier. Do not rely on translated visible copy.
  - Exception: the **Expo Dev Client** boot screen is not our UI; bootstrap flows may use visible copy to connect to Metro.

## Current scope

The default `smoke.yaml` lane intentionally exercises the **real, reachable surfaces** of the current `server-light` mobile harness:

- app boot through Expo Dev Client
- server configuration
- create-account flow
- settings terminal-connect entrypoints
- the real **Start New Session** getting-started guidance when no machine is connected

It does **not** currently include composer-dependent flows (`new-session-composer`, mode chip, agent chip, markdown transcript smoke, keyboard-on-composer smoke), because the ephemeral `server-light` harness does not yet provision a connected Happier machine/daemon for the mobile account created inside the app.

Those flows remain in this folder as the next phase, but they require a connected-machine harness (for example: CLI terminal-connect + daemon bootstrap, and for transcript flows a real provider/session path).

## Run (local)

Prereqs:
- Java 17+
- Android emulator / iOS simulator
- Maestro installed (`maestro --version`)
- Metro running for the Expo Dev Client (default Metro URL: `http://127.0.0.1:8081`)

Install a **development build** on the target device/simulator first:

```bash
# iOS (the default platform)
hstack mobile-dev-client --install --profile=internaldev

# Android
hstack mobile-dev-client --install --platform=android --profile=internaldev
```

The runner resolves the native app identity in this order: explicit `--appId`,
`HAPPIER_E2E_MOBILE_APP_ID`, then the Stack dev-client profile
(`HAPPIER_STACK_DEV_CLIENT_PROFILE`, with
`HAPPIER_MOBILE_DEV_CLIENT_PROFILE` as its alias). The Stack identity helper
owns the standard IDs; `internaldev` is its default. Set the profile before
installing and running when selecting another standard dev client. For a
nonstandard generated app, set `HAPPIER_E2E_MOBILE_APP_ID` to its emitted ID;
also set `HAPPIER_E2E_MOBILE_APP_SCHEME` only if its scheme differs from the
standard selected app.

From repo root:

```bash
yarn -s test:e2e:mobile:android
```

By default the runner starts an ephemeral **server-light** instance (and stops it at the end of the run). To use an existing server instead, set:
- `HAPPIER_E2E_SERVER_URL` (or pass `--serverUrl` through `packages/tests/scripts/run-maestro-with-heartbeat.mjs`)

Optional overrides:
- `HAPPIER_E2E_DEV_CLIENT_METRO_URL` (defaults to `http://127.0.0.1:8081`, translated for Android emulator to `http://10.0.2.2:8081`)
- `HAPPIER_E2E_MOBILE_DEVICE_HOST` (force device-visible host when running on real devices)
- `HAPPIER_E2E_ANDROID_ADB_REVERSE=1` (best-effort `adb reverse` for host Metro/server ports; recommended for local Android emulator runs)

Artifacts are written under:
- `packages/tests/.project/logs/e2e/mobile-maestro/`

## Flow groups

- `smoke.yaml`
  - current default lane
  - should pass against the stock ephemeral `server-light` harness
- `F3.newSessionComposerSmoke.yaml`
- `F4.modeControl.yaml`
- `F7.markdownHorizontalScroll.yaml`
- `F8.keyboardAndNavigationSmoke.yaml`
- `F9.agentInputChipsAndPopovers.yaml`
  - **not** part of default smoke right now
  - require a connected-machine/native session harness that is not fully wired yet
- `transcriptScroll.smoke.yaml`
  - connected-machine transcript viewport smoke
  - creates a tall transcript, reopens it, scrolls up/down, and asserts transcript rows plus composer remain reachable
  - run from repo root with:

```bash
yarn -s test:e2e:mobile:ios:connected-machine:transcript
yarn -s test:e2e:mobile:android:connected-machine:transcript
```

Equivalent direct commands from `packages/tests`:

```bash
HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE=cli-terminal-daemon node scripts/run-maestro-with-heartbeat.mjs --platform ios --flows suites/mobile-e2e/flows/transcriptScroll.smoke.yaml
HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE=cli-terminal-daemon node scripts/run-maestro-with-heartbeat.mjs --platform android --flows suites/mobile-e2e/flows/transcriptScroll.smoke.yaml
```

## Plugin UI current-source lifecycle

The `plugin-platform-current-source` CLI is the native Plugin UI lane for the
current managed development Stack. It deliberately does not accept a
candidate manifest, package tarball, or frozen release identity. The canonical
mobile runner starts one no-dev Metro server from the current checkout, forces
a full Dev Client reload, and runs the native-module probe before its
runner-owned row scenario.

Prepare an authenticated iOS/Android Dev Client against the intended managed
Stack. The CLI resolves that Stack's runtime, exact daemon/machine, catalog,
current platform Inspector RN artifact, and Account credentials itself. It
installs both a unique declarative lifecycle fixture and one ordinary
public-SDK source plugin built by `happier plugins dev build`. The latter owns
RN, hosted Artifact, declarative, self-targeted, Action, and Composer
contributions. Both fixtures advance v1→v2, cycle disable/enable and
uninstall/reinstall, restore v1, and retire through canonical cleanup after
the row. A cleanup failure preserves the source path and reports the failure
instead of hiding an active plugin or deleting diagnostic evidence. No
caller-provided surface URL, artifact handle, or sentinel selects the evidence
target, so sequential iOS→Android and repeated runs do not inherit catalog
state.

Then run, from the repository root on the device host:

```bash
HAPPIER_QA_STACK_RUNTIME_JSON_PATH=<exact-stack.runtime.json> HAPPIER_E2E_IOS_SIMULATOR_UDID=<exact-simulator-udid> corepack yarn --cwd packages/tests -s test:mobile:e2e:ios:plugin-platform-current-source
HAPPIER_QA_STACK_RUNTIME_JSON_PATH=<exact-stack.runtime.json> HAPPIER_E2E_ANDROID_SERIAL=<exact-adb-serial> corepack yarn --cwd packages/tests -s test:mobile:e2e:android:plugin-platform-current-source
```

The wrapper refuses an unqualified device and rejects conflicting environment
and `--udid`/`--device` selectors. The same exact selector drives Maestro and
the installed app-bundle/APK attestation.

The row also runs the canonical external Session Agent journey
(`managed-session-agent.yaml`) for the deterministic public example
(`packages/plugin-sdk/examples/session-agent`, qualified identity
`agent:examples.session-agent/session-agent`). The wrapper installs the
example through its own managed author commands and the canonical dev-and-trust
daemon path, then the flow selects it through the exact chip-picker option,
sends a prompt, settles the host confirmation, observes the assistant
settlement, cancels a later pending confirmation (`agent-input-abort`) and
asserts terminality on-device, and proves the Agent still serves a new turn.
The disposable Session this window creates is attributed and deleted exactly
like the Composer flow's Session.

The maintained automated row now mounts the public external RN surface and its
self-targeted child, the real Swift/Kotlin hosted Artifact frame, and a real New
Session Composer region with two adjacent controls. Host-owned ready markers
attest the exact current self-target/contributor generation fields and the
adopted hosted Artifact digest only after readiness; neither marker exposes an
opaque handle. Distinct target/contributor generation mapping remains
owner-tested; this self-targeted loaded row does not claim independent
cross-plugin generation recovery. The row
also exercises guest-history Back, v1→v2 retirement, disable/enable,
uninstall/reinstall, and v1 restoration. It applies the Composer control's
text, attachment, and reference mutations through the mounted document. It
selects the same source plugin's deterministic public custom Agent, sends the
New Session, observes the assistant transcript sentinel, and asserts the
immutable attachment fallback after acceptance. It never opens or charges a
human backend. Owner-level RN geometry tests remain the exact
44pt/48dp measurement while the loaded row proves adjacent controls are
independently tappable.

VoiceOver/TalkBack cursor traversal, Dynamic Type/font scaling, a deliberate
daemon process restart, and a real Account switch remain separate manual loaded
rows: Maestro cannot safely toggle those platform services or stop a
human-owned managed Stack. Record them independently rather than interpreting
background/foreground as proof. The canonical runner creates one immutable row
revision before Metro starts, compiles it into the no-dev bundle, and requires
the selected app to report that exact compiled revision through the existing
probe. It records the separately captured bundle-content SHA-256 as supporting
byte identity. The wrapper exits with code 2 if that exact loaded-revision
assertion does not pass; a generic module probe or host fetch alone is not
loaded-byte proof.

The hosted guest sentinel proves the native child loaded and behaved but is not
itself an identity fact. The host-owned ready marker becomes visible only after
the exact current native child reports ready and includes the adopted Artifact
digest and projection generation. Together they attest behavior and exact
identity without exposing an opaque Artifact handle.
