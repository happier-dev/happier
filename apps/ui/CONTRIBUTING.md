# Contributing to Happier

## Development Workflow: Build Variants

The Happier UI app supports multiple build variants across **iOS, Android, and desktop (Tauri)**.
Each variant has a distinct native identity so they can be installed side-by-side.

Public users should only care about `stable` / `preview` / `dev` (see `https://docs.happier.dev/docs/advanced/updates`).
In the repo and in CI we also use internal variants for local development.

| Variant | `APP_ENV` | iOS Bundle ID | Android Package | URL scheme | Use case |
| --- | --- | --- | --- | --- | --- |
| **Internal dev** | `development` (alias `internaldev`) | `dev.happier.app.dev.internal` | `dev.happier.app.internaldev` | `happier-internaldev` | Local development with hot reload |
| **Public dev** | `publicdev` | `dev.happier.app.publicdev` | `dev.happier.app.publicdev` | `happier-dev` | Nightly public dev builds + OTA updates |
| **Preview** | `preview` | `dev.happier.app.preview` | `dev.happier.app.preview` | `happier-preview` | Pre-release testing + OTA updates |
| **Production** | `production` | `dev.happier.app` | `dev.happier.app` | `happier` | App Store / Play Store builds |

## Quick Start

### iOS Development

```bash
# Development variant (default)
yarn ios:dev

# Preview variant
yarn ios:preview

# Production variant
yarn ios:production
```

### Android Development

```bash
# Development variant
yarn android:dev

# Preview variant
yarn android:preview

# Production variant
yarn android:production
```

### macOS Desktop (Tauri)

```bash
# Development variant - run with hot reload
yarn tauri:dev

# Build development variant
yarn tauri:build:dev

# Build preview variant
yarn tauri:build:preview

# Build production variant
yarn tauri:build:production
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
yarn tauri:qa
```

**Sanity check the driver port (optional):**
```bash
# Starts a driver session against the default plugin port (9223)
yarn tauri:mcp:session:start
```

**Hook it up to Codex (optional):**
```bash
# Installs the MCP server into Codex’ MCP config
npx -y install-mcp @hypothesi/tauri-mcp-server --client codex
```

**Minimal desktop QA checklist structure (recommended):**
- Setup: start `yarn tauri:qa`, confirm `yarn tauri:mcp:session:start` connects.
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
yarn start:dev

# Start dev server for preview variant
yarn start:preview

# Start dev server for production variant
yarn start:production
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
   yarn ios:dev
   ```

2. **Make your changes** to the code

3. **Hot reload** automatically updates the app

4. **Rebuild if needed** for native changes:
   ```bash
   yarn ios:dev
   ```

### Testing Preview (Pre-Release)

1. **Build preview variant:**
   ```bash
   yarn ios:preview
   ```

2. **Test OTA updates:**
   ```bash
   yarn ota  # Publishes to preview branch
   ```

3. **Verify** the preview build works as expected

### Production Release

1. **Build production variant:**
   ```bash
   yarn ios:production
   ```

2. **Submit to App Store:**
   ```bash
   yarn submit
   ```

3. **Deploy OTA updates:**
   ```bash
   yarn ota:production
   ```

## All Variants Simultaneously

You can install all three variants on the same device:

```bash
# Build all three variants
yarn ios:dev
yarn ios:preview
yarn ios:production
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

- **Production**: `https://app.happier.dev/*`
- **Development**: No deep linking
- **Preview**: No deep linking

This prevents dev/preview builds from interfering with production deep links.

## Testing Connected to Different Servers

You can connect different variants to different Happier CLI instances:

```bash
# Development app → Dev CLI daemon
yarn android:dev
# Connect to CLI running: yarn dev:daemon:start

# Production app → Stable CLI daemon
yarn android:production
# Connect to CLI running: yarn stable:daemon:start
```

Each app maintains separate authentication and sessions!

## Local Server Development

To test with a local Happier server:

```bash
yarn start:local-server
```

This sets:
- `EXPO_PUBLIC_HAPPY_SERVER_URL=http://localhost:3005`
- `EXPO_PUBLIC_DEBUG=1`
- Debug logging enabled

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
   yarn prebuild
   yarn ios:dev  # or whichever variant
   ```

### App not updating after changes

1. **For JS changes**: Hot reload should work automatically
2. **For native changes**: Rebuild the variant:
   ```bash
   yarn ios:dev  # Force rebuild
   ```
3. **For config changes**: Clean and prebuild:
   ```bash
   yarn prebuild
   yarn ios:dev
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
yarn ios:dev  # Should show "Happier (dev)" as the name
```

### Connected device not found

For iOS connected device testing:

```bash
# List available devices
xcrun devicectl list devices

# Run on specific connected device
yarn ios:connected-device
```

## Tips

1. **Use internal dev for active work**: fast iteration and dev-only affordances.
2. **Use preview/public dev for production-like validation**: runs the preview feature policy and uses OTA.
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
