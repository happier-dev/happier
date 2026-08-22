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
