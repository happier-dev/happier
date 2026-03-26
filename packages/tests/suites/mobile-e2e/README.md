# Native E2E (Maestro) — `suites/mobile-e2e`

This suite contains **native** (iOS/Android) E2E flows executed via **Maestro**.

## Philosophy

- **Playwright remains the canonical web UI E2E** (`suites/ui-e2e`).
- Maestro focuses on **native-only regressions**: touch/keyboard/back/gesture/popup rendering.
- Selectors are **`testID`-only**. Do not rely on translated visible copy.

## Run (local)

Prereqs:
- Java 17+
- Android emulator / iOS simulator
- Maestro installed (`maestro --version`)

From repo root:

```bash
HAPPIER_E2E_SERVER_URL=http://127.0.0.1:<port> yarn -s test:e2e:mobile:android
# or (if already exported):
yarn -s test:e2e:mobile:android
```

Artifacts are written under:
- `packages/tests/.project/logs/e2e/mobile-maestro/`
