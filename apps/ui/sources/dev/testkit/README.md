# UI Testkit

Canonical UI-local testing surface for `apps/ui`.

## Buckets

- `mocks/`: canonical module mock factories for repeated UI boundaries
- `fixtures/`: typed app-state and feature fixture builders
- `render/`: shared `react-test-renderer` render surfaces
- `hooks/`: hook render, deferred, and effect-flush helpers
- `harness/`: repeated screen and feature harnesses
- `cleanup/`: shared cleanup registration used by render and hook helpers

## Migration Rules

- Prefer importing from `@/dev/testkit` in new tests.
- Keep `@/dev/testkit`, `@/dev/testkit`, and `@/dev/testkit` only as temporary bridges.
- Prefer `renderSettingsView` or `renderScreen` over file-local `findByTestId` helpers.
- Prefer `renderHook` and `flushHookEffects` over local `renderer.create` hook harnesses and bespoke promise loops.
- Prefer canonical mock factories for `@/text`, `@/modal`, `expo-router`, `react-native`, `react-native-unistyles`, and `@/sync/domains/state/storage`.
