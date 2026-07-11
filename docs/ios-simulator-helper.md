# iOS Simulator Helper — architecture & legal/TOS posture

This documents the first-party `happier-ios-simulator-helper`: the out-of-process macOS binary that
powers the iOS branch of the device-preview tier (live screen stream + native input). It is the iOS
analog of the vendored Android scrcpy server. It also records the **App Store / Apple TOS posture**
for its dependency on Apple's private CoreSimulator/SimulatorKit frameworks (finding #59).

## Why a separate, out-of-process, signed binary

Capturing a booted simulator's framebuffer and injecting native input requires Apple's
**private** `CoreSimulator` and `SimulatorKit` frameworks. These are not part of the public SDK;
they live inside the active Xcode developer directory under `Library/PrivateFrameworks`.

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
- **dlopen, not build-time link.** The helper resolves the private frameworks at runtime from the
  active developer dir via `dlopen`; it does not weak-link them at build time, so the build does not
  depend on their presence and an incompatible Xcode fails closed (`private_framework_symbol_mismatch`).
- **Trusted, signed, notarized.** The helper is treated as a trusted first-party diagnostics/control
  channel. It is launched only after Developer ID signature + notarization + digest verification, and
  only ever through the daemon's binary-safe process starter (which refuses Node/package-manager
  runtimes). See "Trust chain" below.

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
2. **Resolve** — `helperArtifact.ts` rejects the placeholder digest up front, then re-hashes the bytes
   on disk and requires the digest to match the pin.
3. **Sign** — `signature.ts` runs `codesign --verify --strict --deep`, `spctl --assess --type execute`,
   and (optionally) `stapler validate`. Trust is derived only from a daemon-side assessment of the
   bytes, never a caller assertion. Non-macOS hosts fail closed.
4. **Probe** — the helper's `--health-json` must report `available` with the expected codec/input
   capabilities before the streaming process is started.
5. **Launch** — only then does the daemon construct the session owner and advertise capture/input.

If any step fails, iOS capture stays `unavailable` with a precise typed reason and no helper runs.

## Producing the signed artifact (the one external step)

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
Run the iOS argent QA gate on a booted simulator before relying on the flip.
