# @happier-dev/plugin-ui

React and React Native primitives and hooks for Happier plugin authors. Realm-neutral
UI declarations and the host API come from `@happier-dev/plugin-sdk/ui`; this package
adds framework components without declaring a second host contract.

## Plugin UI release posture

Plugin UI has one package-level **Developer Preview** source contract. The
workspace package remains `private: true` at `0.0.0` and is unpublished while
the publication gates are open. Source exports, maintained external-author
fixtures, host wiring, package builds, and loaded development-stack QA establish
feature readiness; they do not establish a released package or public SemVer
policy.

External publication requires an explicit product/release decision. Do not
publish, change versions, or remove the private posture as part of feature or
package-hardening work.

Developer Preview support policy:

- The root entry is the ergonomic, curated author tier. Advanced trusted React
  Native/RNW authors may also import the public `./advanced`,
  `./presentation`, and `./environment` tiers; they compose the same canonical
  implementations and projected environment that Happier core uses, rather
  than a plugin-only primitive library.
- All declared entry points are Developer Preview source contracts while this
  package is private and versioned `0.0.0`; no released compatibility or
  stability promise is implied. Import only the declared package entry
  points, never `src/**` or an undocumented subpath.
- Host factories, internal source files, and app-private UI modules are not public
  plugin APIs.
- React remains a peer dependency supplied by the host workspace.
- React Native is an **optional** peer: it is a host-provided singleton (a plugin
  bundle that inlined it would mount with two runtime worlds), so an author's
  package declares it, externalizes it in its build, and never ships a copy. A
  declarative or hosted-web plugin never installs it at all.

## Package surface

Use the root export for framework components and hooks:

```tsx
import { defineUiSurface, Text } from '@happier-dev/plugin-ui';

function Summary() {
  return (
    <>
      <Text variant="title" tone="accent" value="Review summary" />
      <Text tone="muted" valueKey="acme.review.updated" fallback="Updated just now" />
    </>
  );
}

export const renderSurface = defineUiSurface(Summary);
```

`defineUiSurface` is the artifact entry wrapper: it installs
`PluginUiProvider` around your surface from the render context the host already
passes, so your components never thread `hostApi` or `context` and never mount a
provider themselves.

It must run inside your plugin bundle, not in the host. `@happier-dev/plugin-ui`
is bundled into each plugin artifact rather than host-provided, so a provider
created from a host-owned copy would publish React contexts that your bundled
components cannot read.

The surface stays live: the snapshot the host passes is the FIRST paint, and
every later theme, locale, direction, text-scale and safe-area change arrives
through the host's `watchContext` subscription. Install `PluginUiProvider`
yourself only in an isolated test or complete standalone mount, through the
explicit advanced entry.

RN/RNW artifacts can use `usePluginUiEphemeralSharedScope()` to share one
opaque in-process value between surfaces from the same Account, plugin and
immutable plugin generation. Acquire a versioned plugin-local key only from a
committed effect, subscription or event lifecycle—not during React render—keep
the returned lease for exactly as long as the surface uses the value, and
release it on cleanup. The host disposes the value after its final lease or
when that scope retires. This capability is unavailable to hosted-web frames:
object and function identity cannot cross an iframe, and the hosted bridge has
no scope field. Authors must not replace that boundary with a realm global,
artifact-local cache, JSON mirror or private RPC bridge.

Subpath exports are available for narrower imports:

```ts
import { usePluginHostApi, usePluginResource } from '@happier-dev/plugin-ui';
```

### Advanced trusted-author tier

Use the root tier for ordinary surfaces. When a curated component does not fit
your composition, trusted React Native/RNW authors may import shared primitive
behavior from `/presentation` and the mounted environment facts from
`/environment`:

```tsx
import {
  useHappierUiAccessibility,
  useHappierUiLocalization,
} from '@happier-dev/plugin-ui/environment';
import { HappierStack, HappierText } from '@happier-dev/plugin-ui/presentation';

function AdvancedSummary() {
  const { locale } = useHappierUiLocalization();
  const { textScale } = useHappierUiAccessibility();

  return (
    <HappierStack direction="horizontal" gap={8}>
      <HappierText>{`Summary (${locale}, ${textScale}×)`}</HappierText>
    </HappierStack>
  );
}
```

When an isolated test or complete standalone mount really owns provider and
Resource lifetime, use the explicit advanced entry rather than reopening those
constructors on the beginner root:

```tsx
import { PluginUiProvider } from '@happier-dev/plugin-ui/advanced';
```

`/presentation` exposes lower-level shared primitives and behavior; it does
not grant private app state, host transport, navigation, overlay, or
presentation-host control. `/environment` exposes factual theme, localization,
accessibility, platform, and safe-area capabilities. A mounted surface already
receives those facts through `defineUiSurface`; do not create a second
`PluginUiProvider`, import `presentationHost`, or fabricate a host environment
inside a mounted artifact. `HappierUiEnvironmentProvider` is for an isolated
test or a complete standalone RN/RNW environment where the caller actually owns
every supplied fact.

### Semantic testkit

For semantic RN/RNW author-surface tests, pair the public SDK fixture with the
public RNW adapter:

```ts
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
```

Pass `createPluginUiRnwSemanticSurfaceAdapter()` as the testkit `adapter` in a
React Native Web test environment. The fixture observes bounded semantics only:
the adapter never returns a DOM node, React/native tree, raw test renderer, or
host-private controller. Do not use it to prove layout, portals, focus,
accessibility runtime behavior, native reconciliation, or loaded-host lifecycle
state. Supply `handlers` for genuine host boundaries; a public `PluginError`
thrown by a handler remains a typed host-operation failure.

Use `getByRole` for one target, `getAllByRole` or `queryAllByRole` for a
collection, and bounded `findByRole` for an asynchronously rendered target.
The public semantic vocabulary includes direct author-surface list, form,
radio-group, tab-panel, and separator semantics; it is not a DOM selector API.

This is deliberately not a host-registry or package test: it does not decide
trust, installation, Surface Registry admission, on-demand activation, native
reconciliation, or loaded-host lifecycle behavior. Prove those outcomes through the
real CLI/daemon/UI lane rather than inventing a fixture-only mount refusal.

### Graduation status

Components graduate one family at a time, and each one lands as a single shared
implementation that Happier's own interface renders too — never as a plugin-only
copy. Graduated so far:

| Family | Status |
|---|---|
| `Text` | Real React Native semantics: projected theme typography and tone, user text scale, selectability scope, accessibility identity |
| `Spinner`, `Status`, `State`, `LoadingState`, `EmptyState`, `ErrorState` | Real components over one shared state/feedback implementation Happier's own empty, spinner and status surfaces render too |
| `Button` | Real pressable semantics over the shared press→pending owner Happier's own buttons render: async pending, reentry guard, hover/focus, accessible busy/disabled state |
| `ActionPanel`, `ActionPanel.Section`, `Action.Execute` / `.Copy` / `.OpenExternal` / `.OpenSurface` / `.Refresh` | Real toolbar and action semantics. Each member dispatches through the canonical host method for its concern and reports a typed outcome, including the `outcomeUnknown` settlement that must never be retried blindly |
| `Surface`, `Card` | Real native surface hosts over shared surface/press behavior; Happier's `SurfaceCard` consumes that behavior while applying its app-private RN styles locally |
| `List`, `List.Section`, `List.Item`, `Item`, `ItemGroup` | Real list and row semantics over the shared collection owner. Virtualized `List` owns its bounded search/filter/selected-option state before rows reach the native virtualizer; authors retain match semantics and controlled values. Authors mark independently interactive accessories with `accessoryOutsidePressable`; theme injection, touch-target policy, overflow placement and group indexing remain adapter-owned |
| `Form`, `Form.Field`, `Form.TextField`, `Form.Toggle`, `Form.Select`, `Form.ValidationMessage`, `Form.Actions` | Real form semantics over the canonical action-form owner. Authors provide static already-resolved options; host option sources and account inventory remain host-owned |
| `Popover`, `Menu`, `Dropdown`, `ContextMenu` | Controlled overlay semantics over the incumbent presentation host. It owns anchoring, focus return, Escape, outside dismissal and Android Back; authors supply only semantic state and items |

`./presentation` and `./environment` are the advanced public tier over the
shared implementation and its environment seam. They exist so Happier core and
plugin surfaces reach the same presentation owners; a core adapter may render
its own RN host only when a portable author contract intentionally excludes
required private props/styles. They remain less ergonomic than the root tier,
not host-only or plugin-private.

The root component props are deliberately curated. In particular, `Form` and
`Select` accept author-visible, already-resolved option values instead of Action
schema source instructions or host account metadata; List and overlay adapters
derive host-only injection props from their public semantic inputs.

## Published package contents

Release automation publishes what `files` in `package.json` selects. The
source-owned inclusion contract is:

| Entry | What it is |
|---|---|
| `dist/**` | The compiled output: one `.js`, `.js.map`, `.d.ts` and `.d.ts.map` per module. The `index` and `surfaceEntry` entry modules sit at the root; the rest are under `advanced`, `components`, `composer`, `data`, `environment`, `hostApi`, `presentation`, `presentationHost` and `testing` |
| `package.json` | Package metadata and the declared entry points |
| `README.md` | This file |
| `API.md` | The generated public API inventory |
| `api-surface.json` | The machine-readable public surface the API governance check compares against |
| `api-declarations.md` | The generated declaration listing behind that check |

The three API-governance artifacts ship deliberately: they are the published
record of the public surface, and an author reads `API.md` from
`node_modules/@happier-dev/plugin-ui/` rather than guessing export names. No
`src/**`, test, fixture, or config file is included. Feature QA proves this
selection through source-owned inclusion tests and does not create or install a
local release archive.
