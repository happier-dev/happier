# Native E2E (Maestro) — `suites/mobile-e2e`

This suite contains **native** (iOS/Android) E2E flows executed via **Maestro**.

## Philosophy

- **Playwright remains the canonical web UI E2E** (`suites/ui-e2e`).
- Maestro focuses on **native-only regressions**: touch/keyboard/back/gesture/popup rendering.
- Selectors are **`testID`-only** inside Happier. Do not rely on translated visible copy.
  - Exception: the **Expo Dev Client** boot screen is not our UI; bootstrap flows may use visible copy to connect to Metro.

## Run (local)

Prereqs:
- Java 17+
- Android emulator / iOS simulator
- Maestro installed (`maestro --version`)
- Metro running for the Expo Dev Client (default Metro URL: `http://127.0.0.1:8081`)

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
