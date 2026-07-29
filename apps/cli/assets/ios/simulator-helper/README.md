# iOS simulator helper artifact

This directory is reserved for the first-party packaged `happier-ios-simulator-helper` binary used by the iOS simulator adapter.

## Current status: blocked (fail-closed)

No helper binary is vendored yet. The full in-tree seam is built and active, but the **external artifact** — a Developer ID-signed, notarized, stapled helper binary — has not been produced, so the runtime resolver fails closed and iOS device preview stays unavailable.

What is already in place (the seam — now end-to-end except the signed binary):

- Native helper source: `apps/cli/native/simulator/ios-helper/**` (SwiftPM package linking the private CoreSimulator/SimulatorKit frameworks; implements `--health-json` + `--daemon-json` to the wire contract in `apps/cli/src/daemon/devices/simulator/ios/helperProtocol.ts`).
- Build/sign/notarize/staple pipeline: `apps/cli/scripts/buildIosSimulatorHelper.mjs`.
- Real Gatekeeper signature verifier (`codesign`/`spctl`/`stapler`): `apps/cli/src/daemon/devices/simulator/ios/signature.ts`, wired as the default in `helperArtifact.ts` and into the daemon at `startDaemonSessionControlRuntime.ts`.
- Host-side helper-session owner: `apps/cli/src/daemon/devices/simulator/ios/helperSession.ts` — the single long-lived `--daemon-json` process owner that bridges the helper's stdout NDJSON frame stream into the capture relay (`openStream`) AND writes control commands to its stdin with ack correlation (`sendCommand`, the input sender). Wired into the daemon; constructed only when the artifact verifies.
- Compute-at-build / verify-at-launch digest pin: `apps/cli/src/daemon/devices/simulator/ios/helperPin.ts` derives `PINNED_IOS_SIMULATOR_HELPER_ARTIFACT` from this `manifest.json`. While the manifest carries the blocked placeholder, resolution fails closed; once the signer rewrites it with a real `pinned_signed_notarized_helper` status + sha256, the pin flows through automatically (no source hand-edit).

## To flip iOS capture availability ON (the producer)

1. Run the pipeline on macOS with the existing Apple Developer ID identity used for the desktop (Tauri) DMG:
   ```
   node apps/cli/scripts/buildIosSimulatorHelper.mjs \
     --version <semver> \
     --signing-identity "Developer ID Application: … (TEAMID)" \
     --notary-profile <notarytool-keychain-profile>
   ```
   This builds, codesigns (hardened runtime + timestamp), notarizes (`xcrun notarytool --wait`), staples, and vendors `happier-ios-simulator-helper` + its `.json` sidecar, then rewrites `manifest.json` with the real `version`/`sha256`/`status: pinned_signed_notarized_helper` and signing/notarization evidence.
2. (Automatic) The daemon pin `PINNED_IOS_SIMULATOR_HELPER_ARTIFACT` is derived from the rewritten `manifest.json` via `resolveIosSimulatorHelperPin()` — no source edit. The artifact resolver re-hashes the bytes on disk and verifies they match before launch.
3. (Already implemented) The verified-helper `--daemon-json` stdout → frame-producer stream owner and the stdin control sender both live in `apps/cli/src/daemon/devices/simulator/ios/helperSession.ts` and are wired in `startDaemonSessionControlRuntime.ts`.
4. Run the iOS argent QA gate on a real booted simulator: confirm the live MJPEG stream renders and a native tap is honored, and confirm a tampered/missing artifact stays fail-closed with the precise typed reason.

Do not add a helper binary here unless the exact version, signing/notarization evidence, private-framework compatibility evidence, and SHA-256 digest are recorded in `manifest.json` per the rule above. Absent or unverifiable ⇒ the resolver fails closed.
