# Contributing to Happier

## Development Workflow: Build Variants

The Happier UI app supports multiple build variants across **iOS, Android, and desktop (Tauri)**.
Each variant has a distinct native identity so they can be installed side-by-side.

Public users should only care about `stable` / `preview` / `dev` (see `https://docs.happier.dev/docs/advanced/updates`).
In the repo and in CI we also use internal variants for local development.

| Variant | `APP_ENV` | iOS Bundle ID | Android Package | URL scheme | Use case |
| --- | --- | --- | --- | --- | --- |
| **Internal dev** | `development` (alias `internaldev`) | `dev.happier.app.dev.internal` | `dev.happier.app.internaldev` | `happier-internaldev` | Local development with hot reload |
| **Dev** | `publicdev` | `dev.happier.app.publicdev` | `dev.happier.app.publicdev` | `happier-dev` | Dev builds + OTA updates |
| **Preview** | `preview` | `dev.happier.app.preview` | `dev.happier.app.preview` | `happier-preview` | Pre-release testing + OTA updates |
| **Production** | `production` | `dev.happier.app` | `dev.happier.app` | `happier` | App Store / Play Store builds |

## Quick Start

### iOS Development

```bash
# Development variant (default)
pnpm run ios:dev

# Preview variant
pnpm run ios:preview

# Production variant
pnpm run ios:production
```

### iOS native lifecycle (0.3 development source)

Expo 55 prebuilds use `plugins/withIosSceneLifecycle.js` to adopt one UIKit
application scene. `plugins/ios/SceneDelegate.swift` is compiled beside the generated
AppDelegate; widget and notification-service extensions retain their own targets.
The scene forwards URLs, user activities and lifecycle events to AppDelegate, which
remains the subscriber/link dispatcher. Expo Linking caches the initial URL, so cold
links do not depend on when JavaScript subscribes.

Release bootstraps React Native once in AppDelegate without a window, then attaches
the retained controller when a scene connects. This also starts JavaScript for
background notification actions that do not open a scene. `applicationState` is not
a foreground-launch discriminator. Debug starts its factory inside the scene, with
the window attached before dev-launcher completion. Unlike Expo 54, Expo 55 needs no
delayed AppDelegate subscriber callback; subscribers run normally in both builds.

`patches/expo-updates@55.0.18.patch` allows updates to complete before a scene exists:
the deferred splash view receives the completed root in place. With an existing window,
Expo retains its normal controller replacement. OTA selection, reload and cleanup remain
owned by Expo Updates; the patch does not create a second window. Its native regression
test is `tools/postinstall/expoUpdatesSceneStartup.test.mjs` (requires macOS/Swift).

The independent `plugins/withIosPodDeploymentTargetFloor.js` runs after React Native's
Podfile hook and includes resource-bundle pods. `expo-build-properties` in `app.config.js`
owns deployment target **16.4** and React Native source compilation;
`Podfile.properties.json` supplies the floor, with no second hardcoded target.
The existing Expo Widgets patch exposes its target minimum so the widget target
also consumes that app-configured deployment target and can import the floored pods.
Both plugins reject unknown/partial templates instead of silently skipping migration.
Native changes require a new binary and runtime train (`happierExpoRuntimeVersion` in
`package.json`); publicdev keeps its existing fingerprint policy.

### Android Development

```bash
# Development variant
pnpm run android:dev

# Preview variant
pnpm run android:preview

# Production variant
pnpm run android:production
```

### macOS Desktop (Tauri)

```bash
# Development variant - run with hot reload
pnpm run tauri:dev

# Build development variant
pnpm run tauri:build:dev

# Build preview variant
pnpm run tauri:build:preview

# Build production variant
pnpm run tauri:build:production
```

### Tauri Manual QA Automation (MCP)

This repo ships a **dev-only** Tauri MCP bridge so you can drive the running desktop app for manual QA.

**Already configured in this repo:**
- Dev plugin: `src-tauri/src/lib.rs` enables `tauri_plugin_mcp_bridge` in `#[cfg(debug_assertions)]` builds.
- Dev capability: `src-tauri/capabilities/mcp-dev.json` grants `mcp-bridge:default`.
- Dev config: `src-tauri/tauri.publicdev.conf.json` sets `withGlobalTauri: true` and includes `mcp-dev`.

**Run it locally:**
```bash
# Starts the Tauri app and the MCP server together for manual QA.
pnpm run tauri:qa

# Canonical one-shot native desktop activity-surfaces QA lane.
pnpm run test:native-e2e:activity-surfaces
```

**Sanity check the driver port (optional):**
```bash
# Starts a driver session against the default plugin port (9223)
pnpm run tauri:mcp:session:start
```

**Hook it up to Codex (optional):**
```bash
# Installs the MCP server into Codex’ MCP config
npx -y install-mcp @hypothesi/tauri-mcp-server --client codex
```

**Minimal desktop QA checklist structure (recommended):**
- Setup: start `pnpm run tauri:qa` for a long-lived manual session, or run `pnpm run test:native-e2e:activity-surfaces` for the one-shot deterministic overlay capture. Confirm `pnpm run tauri:mcp:session:start` connects when debugging the bridge directly.
- Onboarding: create account, terminal-connect/pairing, session list visible.
- Local setup flows (desktop-only): file pickers, SSH identity selection, daemon/service controls.
- Error states: bridge disconnected, daemon not running, daemon unauthenticated, relay drift detected + repair task progress.
- Regression: restart app mid-task, confirm snapshot replay + UI recovery.

**How Tauri Variants Work:**
- Base config: `src-tauri/tauri.conf.json` (production defaults)
- Partial configs: `tauri.publicdev.conf.json`, `tauri.preview.conf.json`
- Tauri merges partial configs using [JSON Merge Patch (RFC 7396)](https://datatracker.ietf.org/doc/html/rfc7396)
- Only differences need to be specified in partial configs (DRY principle)

### Development Server

```bash
# Start dev server for development variant
pnpm run start:dev

# Start dev server for preview variant
pnpm run start:preview

# Start dev server for production variant
pnpm run start:production
```

## Visual Differences

Each variant displays a different app name on your device:
- **Development**: "Happier (dev)" - Yellow/orange theme
- **Preview**: "Happier (preview)" - Preview theme
- **Production**: "Happier" - Standard theme

This makes it easy to distinguish which version you're testing!

## Common Workflows

### Testing Development Changes

1. **Build development variant:**
   ```bash
   pnpm run ios:dev
   ```

2. **Make your changes** to the code

3. **Hot reload** automatically updates the app

4. **Rebuild if needed** for native changes:
   ```bash
   pnpm run ios:dev
   ```

### Testing Preview (Pre-Release)

1. **Build preview variant:**
   ```bash
   pnpm run ios:preview
   ```

2. **Test OTA updates:**
   ```bash
   pnpm run ota  # Publishes to preview branch
   ```

3. **Verify** the preview build works as expected

### Production Release

1. **Build production variant:**
   ```bash
   pnpm run ios:production
   ```

2. **Submit to App Store:**
   ```bash
   pnpm run submit
   ```

3. **Deploy OTA updates:**
   ```bash
   pnpm run ota:production
   ```

## All Variants Simultaneously

You can install all three variants on the same device:

```bash
# Build all three variants
pnpm run ios:dev
pnpm run ios:preview
pnpm run ios:production
```

All three apps appear on your device with different icons and names!

## EAS Build Profiles

The project includes EAS build profiles for automated builds:

```bash
# Development build
eas build --profile development

# Production build
eas build --profile production
```

## Environment Variables

Each variant can use different environment variables via `APP_ENV`:

```javascript
// In app.config.js
const variant = process.env.APP_ENV || 'development';
```

This controls:
- Bundle identifier
- App name
- Associated domains (deep linking)
- Intent filters (Android)
- Other variant-specific configuration

## Local Expo config overrides (`app.local.js`)

For local development, you can create an optional file:

- `apps/ui/app.local.js` (gitignored)

If present, it is loaded at the start of `app.config.js` and **deep-merged** on top of the base Expo config.

Example (`apps/ui/app.local.js`):

```js
module.exports = {
  expo: {
    ios: {
      infoPlist: {
        NSPhotoLibraryUsageDescription: 'My fork: used for sharing images.',
      },
    },
  },
};
```

Advanced:
- Set `EXPO_APP_LOCAL_CONFIG_PATH` to load a different override file (useful for keeping multiple variants locally).
- The module can also export a function: `({ variant, baseConfig }) => ({ expo: { ... } })`.

## Deep Linking

Only **production** variant has deep linking configured:

- **Production**: `https://cloud.happier.dev/*` (legacy `https://app.happier.dev/*` links remain supported)
- **Development**: No deep linking
- **Preview**: No deep linking

This prevents dev/preview builds from interfering with production deep links.

## Testing Connected to Different Servers

You can connect different variants to different Happier CLI instances:

```bash
# Development app → Dev CLI daemon
pnpm run android:dev
# Connect to CLI running: pnpm --filter @happier-dev/cli run dev:daemon:start

# Production app → Stable CLI daemon
pnpm run android:production
# Connect to CLI running: pnpm --filter @happier-dev/cli run stable:daemon:start
```

Each app maintains separate authentication and sessions!

## Local Server Development

To test with a local Happier server:

```bash
pnpm exec cross-env EXPO_PUBLIC_HAPPIER_SERVER_URL=http://localhost:3005 pnpm run start:dev
```

This starts the development variant with the local server as its default connection.

## Local neural voice (native model packs)

On iOS/Android, the **Local neural (beta)** STT/TTS backends use downloadable **model packs** (Sherpa-ONNX).

By default, `app.config.js` provides a dev-friendly mapping to a GitHub Release tag, but you can override:
- `EXPO_PUBLIC_HAPPIER_MODEL_PACK_MANIFESTS` — JSON map `{ [packId]: manifestUrl }`
- `EXPO_PUBLIC_HAPPIER_MODEL_PACKS_REPO` — repo slug like `happier-dev/happier-assets`
- `EXPO_PUBLIC_HAPPIER_MODEL_PACKS_TAG` — release tag like `model-packs`

## Troubleshooting

### Build fails with "Bundle identifier already in use"

This shouldn't happen - each variant has a unique bundle ID. If it does:

1. Check `app.config.js` - verify `bundleId` is set correctly for the variant
2. Clean build:
   ```bash
   pnpm run prebuild
   pnpm run ios:dev  # or whichever variant
   ```

### App not updating after changes

1. **For JS changes**: Hot reload should work automatically
2. **For native changes**: Rebuild the variant:
   ```bash
   pnpm run ios:dev  # Force rebuild
   ```
3. **For config changes**: Clean and prebuild:
   ```bash
   pnpm run prebuild
   pnpm run ios:dev
   ```

### All three apps look the same

Check the app name on the home screen:
- "Happier (dev)"
- "Happier (preview)"
- "Happier"

If they're all the same name, the variant might not be set correctly. Verify:

```bash
# Check what APP_ENV is set to
echo $APP_ENV

# Or look at the build output
pnpm run ios:dev  # Should show "Happier (dev)" as the name
```

### Connected device not found

For iOS connected device testing:

```bash
# List available devices
xcrun devicectl list devices

# Run on specific connected device
pnpm run ios:connected-device
```

## Tips

1. **Use internal dev for active work**: fast iteration and dev-only affordances.
2. **Use preview/dev for production-like validation**: runs the preview feature policy and uses OTA.
3. **Use production for final validation**: exact configuration that ships to users.
4. **Install variants side-by-side**: compare behavior without uninstalling.
5. **Match CLI lanes when needed**: `happier` (stable), `hprev` (preview), `hdev` (dev).
6. **Check app name**: always visible which variant you are testing.

## How It Works

The `app.config.js` file reads `APP_ENV` and delegates identity mapping to `appVariantConfig.cjs`:

```javascript
const { getAppEnvironmentConfig } = require("./appVariantConfig.cjs");
const cfg = getAppEnvironmentConfig(process.env.APP_ENV || "development");
const iosBundleId = cfg.iosBundleId;
const androidPackage = cfg.androidPackage;
const scheme = cfg.scheme;
```

The `cross-env` package ensures this works cross-platform:

```json
{
  "scripts": {
    "ios:dev": "cross-env APP_ENV=development expo run:ios"
  }
}
```

Cross-platform via `cross-env` - works identically on Windows, macOS, and Linux!
