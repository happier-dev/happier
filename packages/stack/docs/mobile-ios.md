# Mobile app development (iOS)

This is optional. Most people can use the served web UI on mobile via Tailscale:
see the “Using Happy from your phone” section in the main README.

## Prereqs (one-time)

- Xcode installed
- CocoaPods installed (`brew install cocoapods`)

## Two supported modes

- **Shared dev-client app** (recommended for development):
  - Install *one* “Happy Stacks Dev” app on your phone.
  - Run any stack with `--mobile`; scan the QR to open that stack inside the dev-client.
  - Per-stack auth/storage is isolated via `EXPO_PUBLIC_HAPPY_STORAGE_SCOPE` (set automatically in stack mode).

- **Per-stack “release” app** (recommended for demos / strict isolation):
  - Install a separate iOS app per stack (unique bundle id + scheme).
  - Each stack app is isolated by iOS app container (no token collisions).

## Shared dev-client app (install once)

If you ran `happys setup --profile=dev`, the setup wizard can optionally offer to install the dev-client for you.

Install the dedicated Happy Stacks dev-client app on your iPhone (USB).

This command **runs a prebuild** (generates `ios/` + runs CocoaPods) and then installs a Debug build
without starting Metro:

```bash
happys mobile-dev-client --install
```

If you want to ensure the dev-client is built from a specific stack’s active `happy` worktree
(e.g. to include upstream changes that aren’t merged into your default checkout yet), run:

```bash
happys stack mobile-dev-client <stack> --install
```

Optional:

```bash
happys mobile-dev-client --install --device="Your iPhone"
happys mobile-dev-client --install --clean
```

Then run any stack with mobile enabled:

```bash
happys stack dev <stack> --mobile
# or:
happys dev --mobile
```

Notes:

- **LAN requirement**: for physical iPhones, Metro must be reachable over LAN.
  - Happy Stacks defaults to `lan` for mobile, and will print a QR code + deep link.
  - For simulators you can usually use `localhost` (see `HAPPY_STACKS_MOBILE_HOST` below).
- **If Expo is already running in web-only mode**: re-run with `--restart` and include `--mobile`.

## Per-stack app install (isolated)

Install an isolated app for a specific stack (unique bundle id + scheme, Release config, no Metro):

```bash
happys stack mobile:install <stack> --name="Happy (<stack>)"
happys stack mobile:install <stack> --name="Happy PR 272" --device="Your iPhone"
```

The chosen app name is persisted in the stack env so you can re-run installs without re-typing it.

## Native iOS regeneration / “prebuild” (critical)

You’ll need to regenerate the iOS native project + Pods when:

- you pull changes that affect native deps / Expo config
- `components/happy/ios/` was deleted
- you hit CocoaPods / deployment-target mismatches after a dependency bump

Run:

```bash
happys mobile --prebuild
# (optional) fully regenerate ios/:
happys mobile --prebuild --clean
```

What this does today:

- runs `expo prebuild --no-install` (so we can patch before CocoaPods runs)
- patches `ios/Podfile.properties.json` to:
  - set `ios.deploymentTarget` to `16.0`
  - set `ios.buildReactNativeFromSource` to `true`
- patches the generated Xcode project deployment target (where applicable)
- runs `pod install`

Notes:

- **You usually don’t need to run this manually** because both:
  - `happys mobile-dev-client --install`
  - `happys stack mobile:install <stack>`
  already include `--prebuild`.
- Legacy alias: `happys mobile:prebuild` exists (hidden), but prefer `happys mobile --prebuild`.

## Manual `happys mobile` usage (advanced)

If you want to work on the embedded Expo app directly (outside `happys dev --mobile`), `happys mobile` supports:

```bash
# Start Metro (keeps running):
happys mobile --host=lan

# Build + install on iOS (and exit). If you omit --device, it will try to auto-pick a connected iPhone over USB:
happys mobile --prebuild --run-ios --device="Your iPhone"
happys mobile --prebuild --run-ios --configuration=Release --no-metro
```

## Notes / troubleshooting

- **QR opens the wrong app**:
  - The dev-client QR uses the `HAPPY_STACKS_DEV_CLIENT_SCHEME` (default: `happystacks-dev`).
  - Per-stack installs use a different per-stack scheme, so they should not intercept dev-client QR scans.

- **List connected devices** (for `--device=`):

```bash
happys mobile:devices
```

- **Code signing weirdness on a real iPhone**:
  - Happy Stacks will try to “un-pin” signing fields in the generated `.pbxproj` so Expo/Xcode can reconfigure signing
    (this avoids failures where automatic signing is disabled because `DEVELOPMENT_TEAM`/profiles were pinned).
  - If you want to manage signing manually, pass `--no-signing-fix` to `happys mobile ...` / `happys stack mobile <stack> ...`.

## Bake the default server URL into the app (optional)

If you want the built app to default to your happy-stacks server URL, set this **when building**:

```bash
HAPPY_STACKS_SERVER_URL="https://<your-machine>.<tailnet>.ts.net" happys mobile-dev-client --install
```

Note: changing `HAPPY_STACKS_SERVER_URL` requires rebuilding/reinstalling the app you care about.

Important:

- For **non-main stacks**, `HAPPY_STACKS_SERVER_URL` is only respected if it’s set **in that stack’s env file**
  (safety: we ignore “global” URLs for non-main stacks to avoid accidentally repointing other stacks).

## Customizing the app identity (optional / advanced)

Happy Stacks uses these identities:

- **Dev-client**: defaults to `Happy Stacks Dev` + bundle id `com.happystacks.dev.<user>`
- **Per-stack release**: defaults to `Happy (<stack>)` + bundle id `com.happystacks.stack.<user>.<stack>`

If you want to build/install *manually* (instead of `mobile-dev-client` / `stack mobile:install`), you can override:

- **Bundle identifier (recommended for real iPhones)**:
  - You may need this if the bundle id you’re using isn’t available/owned by your Apple team.

```bash
HAPPY_STACKS_IOS_BUNDLE_ID="com.yourname.happy.local.dev" happys mobile --prebuild --run-ios --no-metro
```

- **App name (what shows on the home screen)**:

```bash
HAPPY_STACKS_IOS_APP_NAME="Happy Local" happys mobile --prebuild --run-ios --no-metro
```

## Suggested env (recommended)

Add these to your main stack env file (`~/.happy/stacks/main/env`) (or `~/.happy-stacks/env.local` for global overrides) so you don’t have to prefix every command:

```bash
# How the phone reaches Metro:
# - lan: recommended for real devices
# - localhost: OK for simulators
HAPPY_STACKS_MOBILE_HOST="lan"

# (optional) default scheme used in the dev-client QR / deep link
# (must match your installed dev-client app):
HAPPY_STACKS_DEV_CLIENT_SCHEME="happystacks-dev"

# Default public server URL for the stack (baked into the Expo app config):
HAPPY_STACKS_SERVER_URL="https://<your-machine>.<tailnet>.ts.net"

# Optional: home screen name:
HAPPY_STACKS_IOS_APP_NAME="Happy Local"
```

## EAS builds per stack (production / App Store-like)

This section documents the end-to-end workflow for producing a **fully working** EAS Build (cloud) for a stack,
with a **custom bundle id + app name** (example: `com.leeroybrun.happier` / `Happier`), while keeping upstream defaults unchanged when env vars are unset.

### Overview

To get a reliable EAS build for a stack-specific app identity, you generally need:

- a **Happy monorepo worktree** that contains the app config hooks (dynamic `app.config.js`)
- a stack pinned to that worktree (`happys stack wt <stack> -- use happy ...`)
- stack env vars describing the **app identity** (bundle id, name, scheme, etc.)
- EAS **environment variables** configured on Expo (so the cloud builder sees the same values)
- an initial **interactive** credentials setup (iOS signing) before non-interactive builds work
- for identity changes: run **prebuild** so `ios/` + `android/` native projects reflect the new id

### 1) Create (or select) a stack + pin a worktree

Example stack name: `happier`.

Create a `happy` monorepo worktree from your fork branch (example):

```bash
happys wt new happy happier --from=origin --base=origin/happier
```

Pin the `happier` stack to that worktree:

```bash
happys stack wt happier -- use happy leeroybrun/happier
```

### 2) Set the app identity in the stack env (local + build-time config)

These are evaluated by `packages/happy-app/app.config.js` when building:

```bash
happys stack env happier set \
  APP_ENV=production \
  EXPO_APP_NAME="Happier" \
  EXPO_APP_BUNDLE_ID="com.leeroybrun.happier" \
  EXPO_APP_SCHEME="happier" \
  EXPO_APP_SLUG="happier" \
  EXPO_APP_OWNER="leeroybrun"
```

Notes:

- `APP_ENV` drives the built-in variant logic (development/preview/production).
- `EXPO_APP_*` overrides keep upstream defaults intact when unset.

### 3) Regenerate native projects (“prebuild”) when changing identity

When changing bundle IDs / schemes / config plugins, you should run a clean prebuild so native projects match the config:

```bash
happys stack mobile happier --prebuild --platform=ios --clean --no-metro
# or:
happys stack mobile happier --prebuild --platform=all --clean --no-metro
```

### 4) Make sure the cloud builder sees your env vars (EAS Environment Variables)

Cloud builds do **not** automatically inherit your local shell env.
You must configure EAS Environment Variables on Expo (project settings) and ensure your build profile selects an environment.

The EAS project env var workflow:

1) Ensure your `eas.json` build profiles set `"environment": "production"` / `"preview"` / `"development"`.
2) Create env vars in EAS for that environment (plain text or sensitive so config resolution can read them).

With Happy Stacks helpers (stack-scoped):

```bash
# Inspect:
happys stack eas happier env:list --environment production

# Create (use env:update if it already exists):
happys stack eas happier env:create --name EXPO_APP_NAME --value "Happier" --environment production --visibility plainText
happys stack eas happier env:create --name EXPO_APP_BUNDLE_ID --value "com.leeroybrun.happier" --environment production --visibility plainText
happys stack eas happier env:create --name EXPO_APP_SCHEME --value "happier" --environment production --visibility plainText
happys stack eas happier env:create --name EXPO_APP_OWNER --value "leeroybrun" --environment production --visibility plainText
happys stack eas happier env:create --name EXPO_APP_SLUG --value "happier" --environment production --visibility plainText
```

Tip:

- If you see “No environment variables with visibility Plain text and Sensitive found…”, it means your EAS environment variables are missing (or set to `secret`).

### 5) EAS project + account sanity checks

If you see permission errors, verify the Expo account:

```bash
happys stack eas happier whoami
happys stack eas happier login
```

If the project is not initialized/linked under your account yet:

```bash
happys stack eas happier project:init
```

### 6) Build (iOS / Android)

First-time iOS credential setup usually requires interactive mode:

```bash
happys stack eas happier ios --profile production --interactive
```

After credentials are set up, you can run non-interactive builds:

```bash
happys stack eas happier ios --profile production --no-wait --non-interactive
happys stack eas happier android --profile production --no-wait --non-interactive
```

### Common pitfalls

- **`eas.json is not valid` / `"build.base" must be of type object`**:
  - your `eas.json` is using an old schema; update `build.base` to an object and use `"extends": "base"`.
- **`Credentials are not set up. Run this command again in interactive mode.`**:
  - run the same build with `--interactive` once to configure iOS signing.
- **Cloud build doesn’t see stack env vars**:
  - set EAS environment variables (project settings) and make sure your profile has `"environment": "production"`.
