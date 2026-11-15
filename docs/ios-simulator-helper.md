# iOS Simulator Helper — architecture & legal/TOS posture

This documents the first-party `happier-ios-simulator-helper`: the out-of-process macOS scaffold for
the iOS branch of the device-preview tier (live screen stream + native input). It is the iOS
analog of the vendored Android scrcpy server. It also records the **App Store / Apple TOS posture**
for its dependency on Apple's private CoreSimulator/SimulatorKit frameworks (finding #59).

**Development status:** the native framebuffer and HID producers are unimplemented. The helper
reports `ios_private_helper_unavailable` with diagnostic code
`ios_capture_producer_unimplemented`; it advertises no capture or input and never acknowledges an
input effect as accepted. Booted devices remain discoverable. Building, signing and notarizing this
scaffold cannot enable preview; implementing and verifying the native producer is a separate owner
decision. The transport and trust-chain descriptions below describe the intended integration.
The daemon health owner also withdraws older local scaffold builds that report `available` after
framework loading alone, so an unrecompiled helper cannot restore a false capability claim.

## Why a separate, out-of-process, signed binary

Capturing a booted simulator's framebuffer and injecting native input requires Apple's
**private** `CoreSimulator` and `SimulatorKit` frameworks. These are not part of the public SDK;
their locations depend on the installed Xcode and CoreSimulator tooling.

Daemon discovery resolves `simctl` through `xcrun --find simctl`, then enumerates booted devices
through `xcrun simctl list devices booted --json`. Apple tooling owns developer selection (including
`DEVELOPER_DIR`) and CoreSimulator location resolution. Discovery does not infer framework paths:
booted devices remain visible when the separate capture-helper health check reports unavailable.

The posture that keeps this defensible and App-Store-safe:

- **Containment by separation.** The private-framework dependency lives **only** in this standalone
  helper binary. It is never linked into, bundled with, or reachable from any App-Store-distributed
  Happier build. The App Store binary contains zero private-framework symbols.
- **Local developer tool, not a shipped product feature.** The helper drives a developer's **own
  local Xcode simulator** on the developer's own Mac. It is a development/QA affordance — the same
  category as `xcrun simctl`, scrcpy, or Xcode's own tooling — not a capability exposed to end users
  of a published app.
- **Out-of-process.** The helper runs as a separate child process launched by the daemon. The daemon
  itself does not link the private frameworks; it speaks a JSON wire protocol over stdio. A
  private-framework symbol/availability mismatch surfaces as a typed `unavailable` reason rather than
  crashing or tainting the host.
- **dlopen, not build-time link.** The helper loads the private frameworks at runtime via `dlopen`;
  it does not weak-link them at build time. Its current resolver checks `Library/PrivateFrameworks`
  under the active developer directory, so installations with CoreSimulator elsewhere report
  unavailable. Framework loading and symbol checks belong to helper health, separately from device
  discovery; an incompatible symbol surface fails closed (`private_framework_symbol_mismatch`).
- **Trusted, signed, notarized.** The helper is treated as a trusted first-party diagnostics/control
  channel. Published runtimes require Developer ID signature + notarization + digest verification.
  Source/dev runtimes may use the local development build described below. Both launch through
  the daemon's binary-safe process starter (which refuses Node/package-manager runtimes). See "Trust chain" below.

This mirrors how the Android scrcpy server is vendored and pinned, and how the desktop (Tauri) build
signs/notarizes with the same Developer ID identity.

## Components (canonical owners)

| Concern | Owner |
|---|---|
| Native source (Swift) | `apps/cli/native/simulator/ios-helper/**` |
| Wire protocol (TS contract) | `apps/cli/src/daemon/devices/simulator/ios/helperProtocol.ts` |
| Health schema | `packages/protocol/src/devices/simulator/iosV1.ts` |
| Build + sign + notarize + staple + vendor | `apps/cli/scripts/buildIosSimulatorHelper.mjs` |
| Vendored artifact + manifest | `apps/cli/assets/ios/simulator-helper/**` |
| Digest pin (compute-at-build, verify-at-launch) | `apps/cli/src/daemon/devices/simulator/ios/helperPin.ts` |
| Artifact resolver (digest + signature + version) | `apps/cli/src/daemon/devices/simulator/ios/helperArtifact.ts` |
| Gatekeeper signature verifier (`codesign`/`spctl`/`stapler`) | `apps/cli/src/daemon/devices/simulator/ios/signature.ts` |
| Probe lifecycle (health probe + process start) | `apps/cli/src/daemon/devices/simulator/ios/helper.ts` |
| **Stream + input session owner** | `apps/cli/src/daemon/devices/simulator/ios/helperSession.ts` |
| Frame producer (helper frame → capture frame) | `apps/cli/src/daemon/devices/simulator/ios/helperFrameProducer.ts` |
| Input dispatch (control → helper command) | `apps/cli/src/daemon/devices/simulator/ios/input.ts` |
| Platform adapter (discovery + dispatch) | `apps/cli/src/daemon/devices/simulator/platform/ios.ts` |
| Daemon wiring | `apps/cli/src/daemon/startup/startDaemonSessionControlRuntime.ts` |

## The session owner (capture + input from one process)

`createIosSimulatorHelperSession` owns a single long-lived `--daemon-json` helper child with piped
stdio. It is BOTH:

- the **capture producer** — `openStream` registers a frame consumer; the owner parses newline-
  delimited JSON from the helper's stdout and routes `frame` messages to the matching consumer, which
  feeds the canonical `server_relay` capture path; and
- the **input sender** — `sendCommand` writes a serialized control command to the helper's stdin and
  resolves on the correlated `control_ack` (with timeout + fail-closed on process exit).

This is the iOS analog of the Android scrcpy server handle, which serves both the raw video stream
and the control socket from one server process. Tap/swipe/keyboard/hardware-button controls map
through `helperProtocol.ts`'s serializer and the helper's `InputDispatcher`.

## Trust chain (fail-closed end to end)

1. **Pin** — `helperPin.ts` reads the vendored `manifest.json`. Only a `pinned_signed_notarized_helper`
   + `prebuilt-signed` manifest with a real version and non-placeholder sha256 yields a real pin;
   everything else (unbuilt, dev build, placeholder digest, malformed) falls back to the all-zero
   placeholder pin.
2. **Resolve** — `helperArtifact.ts` asks the canonical runtime authority once. Published runtimes
   reject the placeholder digest up front, then re-hash the bytes and require the digest to match
   the pin. Source/dev runtimes instead resolve the local build at the fixed path below and require
   its version sidecar to match the owning CLI package version.
3. **Sign (published runtimes)** — `signature.ts` runs `codesign --verify --strict --deep`, `spctl --assess --type execute`,
   and (optionally) `stapler validate`. Trust is derived only from a daemon-side assessment of the
   bytes, never a caller assertion. Non-macOS hosts fail closed.
4. **Probe** — the helper's `--health-json` must report `available` with the expected codec/input
   capabilities before the streaming process is started.
5. **Launch** — only then does the daemon construct the session owner and advertise capture/input.

If any step fails, iOS capture stays `unavailable` with a precise typed reason and no helper runs.

## Producing the signed artifact (after native producer implementation)

Code-signing/notarization requires the user's Apple Developer ID and cannot be performed in this
repo's automation. On macOS, with the same Developer ID identity used for the desktop DMG:

```
node apps/cli/scripts/buildIosSimulatorHelper.mjs \
  --version <semver> \
  --signing-identity "Developer ID Application: <NAME> (<TEAMID>)" \
  --notary-profile <notarytool-keychain-profile>
```

This builds (universal arm64+x86_64), codesigns (hardened runtime + secure timestamp), notarizes
(`xcrun notarytool submit --wait`), staples, vendors the binary + sidecar, and rewrites
`manifest.json`. The daemon pin is then derived from that manifest automatically — no source edit.
The current scaffold remains unavailable after this build. Once a real producer is implemented,
run the iOS argent QA gate on a booted simulator before relying on availability.

## Local development build (0.3 source/dev runtimes)

On the Mac that runs the source daemon, from the same checkout:

```sh
node apps/cli/scripts/buildIosSimulatorHelper.mjs --skip-notarize
```

The existing producer builds the repo's Swift source and ad-hoc signs the result, requiring no
Developer ID, keychain profile or notarization. It writes the helper and version sidecar to
`apps/cli/node_modules/.cache/happier-ios-simulator-helper/happier-ios-simulator-helper` (ignored), using
the CLI package version. It does not write release assets or alter the release manifest.

The canonical runtime authority (`resolveAuthoritativePackagedRuntimeProjectRoot`) selects
source modules and source snapshots. Their resolver requires this fixed local path and matching
version sidecar; it skips release digest pinning and Apple notarization. A missing build reports
`helper_artifact_missing` with the build command; a stale or absent sidecar reports
`helper_version_mismatch`. Rebuild after changing the CLI version. Published/package runtimes
continue using only the pinned signed/notarized artifact, even if a dev build is present.
Helper health, capture capability and input availability still come from the ordinary native probe.
