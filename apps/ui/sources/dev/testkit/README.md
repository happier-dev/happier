# UI Testkit

Canonical UI-local testing surface for `apps/ui`.

## Buckets

- `mocks/`: canonical module mock factories for repeated UI boundaries. Inside a `vi.mock` factory,
  import the factory's own module (for example `@/dev/testkit/mocks/reactNative`, `mocks/unistyles` or
  `mocks/popover`), not `@/dev/testkit`. The index's import graph loads the module being mocked: for
  `react-native` the factory waits on itself and collection never finishes, and for others the mock can
  silently not apply.
- `fixtures/`: typed app-state and feature fixture builders
- `render/`: shared `react-test-renderer` render surfaces
- `hooks/`: hook render, deferred, and effect-flush helpers
- `harness/`: repeated screen and feature harnesses
- `cleanup/`: shared cleanup registration used by render and hook helpers
- `harness/hitFrameReach`: `readHitArea(node, drawn?)` is the effective hit rect (native `hitSlop` or the web `[data-happier-hit-area]` frame, border excluded) and `hitAreaOverlap(a, b, { axis, gap })` is how far neighbours overrun their gap; read hit areas through them, never re-derive from props or styles.
- `performance/`: deterministic render/commit, real-store notification, transport request and live timer counts

## Performance contracts

Use `createRenderCommitCounter` with `useRenderCommitCounter` inside the mounted
consumer, then `reset()` after settling the mount. Renders count render attempts;
commits count layout effects, so an abandoned render is not mistaken for a commit.
Keep StrictMode explicit in the scenario rather than dividing counts afterwards.

`countStoreNotifications(realStore)` records every notification and its changed
top-level keys, including `[]` for an empty merge that still notifies Zustand.
Always call `stop()` before restoring the store. `countTransportRequests` wraps
the actual HTTP/RPC boundary: its caller supplies a method/route key and only
physical requests are counted, including failed requests. Do not wrap an internal
domain reader or include credentials, bodies or query secrets in the key.

Install `installTimerCensus` after fake timers and before mounting. Its stack
classifier names the known timer owner; unknown callers remain `consumer: null`.
Check both the records and `vi.getTimerCount()` so pre-existing timers cannot hide
outside the capture. `stop()` restores the timer boundary; the surface still owns
cancelling its timers. Fake timers must be restored after stopping the census.

Budgets belong next to the owner contract and state the observed baseline and
update basis. Zero unrelated renders/notifications/timers has no noise margin;
changing that budget requires evidence that the additional work has a consumer.

## Migration Rules

- Prefer importing from `@/dev/testkit` in new tests.
- After publishing fresh Machine rows, use `observeMachinePresenceForTest(scope, machineIds)`
  from `harness/machinePresence` to feed the real presence observation owner. A retained row or
  a transport reconnect alone does not establish fresh presence. This runtime-bearing helper
  stays off the root barrel, and it never clears failed requests or admits revoked Machines.
- Import a bucket module directly only when its helper is intentionally not part of the root testkit surface.
- Import `homeGovernanceHarness` and `providerSettingsHarness` from their own `harness/` modules. They load domain runtime state and are deliberately not exported by the lightweight root surface.
- Prefer `renderSettingsView` or `renderScreen` over file-local `findByTestId` helpers.
- Prefer `renderHook` and `flushHookEffects` over local `renderer.create` hook harnesses and bespoke promise loops.
- Prefer canonical mock factories for `@/text`, `@/modal`, `expo-router`, `react-native`, `react-native-unistyles`, and `@/sync/domains/state/storage`.
- Keep the global setup light. A module whose process-global state must not leak between tests registers its own
  reset when it loads (`dev/vitestTestResets.ts`; `machineReachability.ts` is the example). Never import or
  `vi.importActual` a module from `dev/vitestSetup.ts` only to reset it: that cold-loads its graph on every file's first test.
- For web viewport fixtures, override `Dimensions.get` once in `createReactNativeWebMock`; its default `useWindowDimensions` reads the same window port.

## Transport boundary import order

The root `@/dev/testkit` entry stays free of runtime singletons and may be statically imported.
Home and Provider harnesses are available from their owning `harness/homeGovernanceHarness` and
`harness/providerSettingsHarness` modules. Install their HTTP/RPC boundaries before importing screens,
hooks, or other runtime consumers, including layout components whose dependency graph reaches Sync.
The Machine Administration selection fixture/mock also imports a runtime owner; use its own
`mocks/machineAdministrationTargetSelection` module and load it after Home boundary installation.
Registry UI mocks load the bundled plugin catalog and are available only from
`mocks/registryUiBehavior`; unrelated root-testkit consumers do not load that catalog.
Storage mocks and the ChatList harness load real Settings and the Agent/Voice catalogs;
import them from `mocks/storage` and `harness/chatListHarness` only in suites that need them.
Root-exported fixtures use the Protocol's narrow public subpaths rather than its complete barrel.
Load those consumers with `await import(...)` after installation:

```ts
import { renderScreen } from '@/dev/testkit';
import {
    createProviderSettingsHarness,
    createProviderSettingsAccountHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';

const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness(); // Installs Home HTTP and Socket boundaries.
const { ProviderConnectionsSettingsScreen } = await import(
    '@/components/settings/providers/ProviderConnectionsSettingsScreen'
);
```

Home HTTP installation updates the real `runtimeFetch` port, so already imported HTTP clients use the
current boundary without reloading their runtime graph. The Socket installer rejects already imported
real Socket transports with a `[testkit]` error naming the installer and module: `vi.doMock` affects
later imports and cannot replace references held by a screen. Move the premature Socket import rather
than using `vi.resetModules`. Reinstalling a correctly installed boundary remains supported; its
delegates read the current harness at call time. For a suite that must statically import a Socket consumer, use the hoisted
`vi.mock('socket.io-client', ...)` factory documented in `serverAccountConnectionHarness.ts` before
configuring it with `installDisconnectedServerSocketBoundary`.
