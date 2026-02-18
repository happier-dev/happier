# Desktop updates & signing (Tauri)

This folder contains the Tauri (desktop) app for Happier.

## Current status

- Automatic updates are implemented via the Tauri v2 updater plugin:
  - Rust registers the updater plugin and exposes Tauri commands used by the UI.
  - `tauri.conf.json` configures the stable update endpoint; `tauri.preview.conf.json` overrides it for preview.
  - GitHub Actions publishes platform updater artifacts plus a `latest.json` feed used by the app.

## Two different “signing” concepts

### 1) Updater signing (update integrity)

Tauri’s updater mechanism can verify that update metadata and/or update artifacts were produced by you (tamper protection). This is *not* the same as OS-level code signing.

Typical setup:

1. Generate an updater signing keypair (private key + public key).
2. Embed the **public key** in the app’s Tauri config so the app can verify signatures.
3. Store the **private key** in GitHub Secrets and use it in CI to sign updater metadata/artifacts.

The CI workflow is already pre-wired to pass these secrets if you add them:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

### 2) Code signing (OS trust / installer UX)

This is what reduces “unknown developer/publisher” warnings:

- macOS: codesign + notarization (Gatekeeper).
- Windows: Authenticode signing (SmartScreen reputation).

You can do updater signing without code signing, and vice-versa.

## Recommended release model (repo convention)

We publish UI Desktop component releases:

- Production: tag/release `ui-desktop-vX.Y.Z`
- Preview (rolling prerelease): tag/release `ui-desktop-preview` (assets replaced on each build)
- Stable update feed (rolling): tag/release `ui-desktop-stable` (hosts `latest.json` pointing at the latest `ui-desktop-vX.Y.Z` assets)

Desktop updater artifacts and feeds are published by `.github/workflows/build-tauri.yml` through the centralized publisher `.github/workflows/publish-ui-release.yml`.

## Implementing auto-updates (recommended approach)

We use the official Tauri updater plugin and a static JSON feed (`latest.json`) published to GitHub Releases.

Key pieces:

- Rust: `tauri-plugin-updater` in `Cargo.toml`, registered in `src/lib.rs`.
- Config: `plugins.updater` in `tauri.conf.json`:
  - `endpoints` (stable) and `pubkey` (base64-encoded minisign public key; Tauri updater signing uses minisign, not PEM)
  - preview overrides endpoints in `tauri.preview.conf.json`
- CI: enable `bundle.createUpdaterArtifacts` and publish:
  - platform update bundles (per target)
  - `latest.json` (preview: `ui-desktop-preview/latest.json`, stable: `ui-desktop-stable/latest.json`)

Notes:
- For preview vs production update channels, you usually either:
  - provide different endpoints (preview vs production), or
  - embed logic/config per environment (`tauri.preview.conf.json` vs `tauri.conf.json`).

## macOS codesigning & notarization (overview)

You already have the Apple Developer Program, which includes “Developer ID” certificates for macOS distribution.

Typical CI inputs:

- A Developer ID Application certificate exported as `.p12` + password (stored as secrets).
- Notarization credentials:
  - either Apple ID + app-specific password, or
  - App Store Connect API key (preferred for CI).

Typical CI process:

1. Import `.p12` into a temporary keychain on the runner.
2. Build and codesign the app bundle.
3. Submit to Apple notarization.
4. Staple the notarization ticket to the app.

## Windows code signing (overview)

Windows signing generally requires purchasing a code signing certificate from a Certificate Authority (CA). EV certificates are more expensive but improve SmartScreen reputation.

Typical CI inputs:

- `.pfx` certificate + password (stored as secrets) OR a remote signing service/HSM.

Typical CI process:

1. Build the installer/binary.
2. Run `signtool` to sign it.
3. Timestamp the signature.
