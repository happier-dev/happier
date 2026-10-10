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

For universal executable UI, the compiler externalizes the public
`@happier-dev/plugin-ui` export family. The app supplies one physical package
instance through its same-realm host module map, so the wrapper and your
components share React contexts. Export `defineUiSurface(Summary)` from your
artifact entry; the wrapper binds the host-supplied render context and the host
attaches its private provider services. Hosted web runs in a separate iframe
realm. See the canonical [UI artifact contract](https://docs.happier.dev/plugins/ui/ui-artifacts).

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
when that scope retires. Values that retain opaque execution-origin state such
as provider continuations can return `onExecutionOriginChange`; the host calls
it before a surviving lease on another origin becomes active, while same-origin
client replacement remains uninterrupted. This capability is unavailable to hosted-web frames:
object and function identity cannot cross an iframe, and the hosted bridge has
no scope field. Authors must not replace that boundary with a realm global,
artifact-local cache, JSON mirror or private RPC bridge.

Subpath exports are available for narrower imports:

```ts
import { usePluginHostApi, usePluginResource } from '@happier-dev/plugin-ui';
```

### Responsive composition

Use `ListDetailLayout` for a collection and its selected detail in a bounded
fill region. Supply the readable minimum width of each pane and your preferred
list ratio; account for your content's text scale and inner padding in those
minimums. The component measures its own width, reserves the gap, and shows both
panes only when they fit. Until measured, an active detail occupies the region.

```tsx
<ListDetailLayout
  minListWidth={320}
  minDetailWidth={480}
  preferredListRatio={0.4}
  gap="small"
  list={listContent}
  detail={selectedDetail}
/>
```

Selection, navigation and loading remain with the caller. Set `detail` to `null`
to show only the list, or keep a route outlet supplied and control its visibility
with `detailActive`. For a collection index that shows an introduction beside
the list on wide screens, set `detailActive` and `stackedPane="list"`; the list
then stays visible alone when the panes cannot fit. Both pane hosts retain their
identity across resizing and
visibility changes; inactive content stays mounted, hidden from layout and
assistive technology. The caller still owns the identity of the content it
supplies. A `list` render function can read the same measured layout for local
composition; it receives `null` before the first measurement. Put outer padding
around the component and pane padding in `listStyle` or `detailStyle` so its
measurement represents the available pane region.

Use `Columns` with `Column` children for a wrapping layout of up to four columns
per row. `minColumnWidth` determines how many columns fit in the measured
container, `columns` requests their maximum count, and `span` assigns a child
that many column slots, capped at the current count. Children keep their
identity when the container changes width. These components share Happier
core's column implementation; collection selection and data-grid semantics
remain with the caller.

### Capture previews and Session images

This media interface is under development in 0.3. Use these examples only when
your installed SDK and Plugin UI API inventories list the media exports below.

In a mounted Happier RN/RNW surface, `HappierLiveStream` presents a read-only
capture reference through the host's existing stream transport and decoder:

```tsx
<HappierLiveStream
  reference={{ kind: 'plugin', source: { pluginId: 'acme.board', localId: 'preview' } }}
  testID="board-preview"
  fallback={<Text value="Capture previews need a Happier window" />}
/>
```

The source must be declared by this plugin's `captureSources` contribution.
A `{ kind: 'host', sourceId }` reference asks to view a host capture instead.
Each viewer occurrence goes through the existing `capture.view` Action approval;
approval is required by default, and the user can waive it for a particular
plugin in Action settings. Replacing a source closes the old viewing rather
than inheriting its consent. A plugin's own declared capture needs no additional
viewing approval. The component supplies no input or takeover authority: those
stay with host-approved Actions. Where no host renderer is supplied, `fallback`
renders; caller-hosted HTML does not acquire the app's stream renderer.

`StoredImage` takes a `StoredImageRefV1` from `@happier-dev/plugin-sdk/ui`:
the complete file-backed native Session-image reference, including `mediaId`,
`mediaKind`, dimensions, `sizeBytes` and `file` storage/path/digest facts. Pass
the reference from a capture, attachment, snapshot or Session event directly.
It may be reused after remounting or handed to another plugin; no per-mount
Action-result allowlist grants permission. Each read requires the plugin's declared
`sessions` HostAccess **read** scope, including the selected scope for optional
access. It does not inherit the Account-wide linked-Session UI scope. Account
mode and the media's encoding must agree; unavailable encryption material and
mode mismatches stay unavailable rather than falling back to plaintext.

The daemon verifies the exact Session artifact bucket, real file path, size,
digest and image encoding before disclosing bytes. A result's producer does not
replace Sessions READ authority. `sessions.media.publishGenerated` currently
returns publication status, not this native artifact reference; generated-media
records are not interchangeable with `StoredImageRefV1`.

```tsx
<StoredImage image={imageReference} accessibilityLabel="Captured page preview" />
```

Both the app thumbnail and `StoredImage` use the shared `HappierStoredImage`
presentation owner. These are Developer Preview source interfaces, not a claim
of package publication or loaded-runtime certification.

### Settings and detail pages

A plugin page that configures something uses Happier's configuration-page
anatomy through the same presentation owners Happier's own settings use:
`PageHeader` (title, purpose, identity mark, meta line, actions; the host places
its back arrow and hides the title under a native header), `ItemGroup` with a
sentence-case `title`, `description` and optional section `action` (one hairline
sheet, rows divided by full-width hairlines), `Item` rows with one control in
`accessory`, `Toggle`, `Select` with `presentation="segmented"` or `"field"`,
`TextField presentation="field"` (typed in place, saved on leaving with `onCommit`),
`SelectionTiles`, and `EmptyState` with `layout="page"` or `"line"`. Page
geometry and type come from one owner (`HAPPIER_PAGE_METRICS`,
`HAPPIER_PAGE_TEXT` in `./presentation`); a same-realm host also installs its
exact page colours (`HappierUiPalette`) and page chrome, and without them the
colours resolve from the public theme snapshot. See the published guide
"Settings and detail pages" (`apps/docs/content/docs/plugins/ui/configuration-pages.mdx`).

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

Advanced Resource clients can publish intermediate `ResourceContent` through
the read options' optional `onProgress` callback. The same entry admits those
bytes under the read's existing signal and Account lifetime, preserves identical
digest references, and keeps `pending` until the read settles. Retirement or
authority withdrawal rejects later progress. This is a Developer Preview
package construction seam, not another `PluginUiHostApi` method or wire stream.

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
| `ListDetailLayout`, `Columns`, `Column` | Shared measured composition used by Happier core and plugin surfaces; pane and column children retain their identity across responsive layout changes |
| `Text` | Real React Native semantics: projected theme typography and tone, user text scale, selectability scope, accessibility identity |
| `Spinner`, `Status`, `State`, `LoadingState`, `EmptyState`, `ErrorState` | Real components over one shared state/feedback implementation Happier's own empty, spinner and status surfaces render too |
| `Button` | Real pressable semantics over the shared press→pending owner Happier's own buttons render: async pending, reentry guard, hover/focus, accessible busy/disabled state |
| `ActionPanel`, `ActionPanel.Section`, `Action.Execute` / `.Copy` / `.OpenExternal` / `.OpenSurface` / `.Refresh` | Real toolbar and action semantics. Each member dispatches through the canonical host method for its concern and reports a typed outcome, including the `outcomeUnknown` settlement that must never be retried blindly |
| `Surface`, `Card` | Real native surface hosts over shared surface/press behavior; Happier's `SurfaceCard` consumes that behavior while applying its app-private RN styles locally |
| `List`, `List.Section`, `List.Item`, `Item`, `ItemGroup` | Real list and row semantics over the shared collection owner. Virtualized `List` owns its bounded search/filter/selected-option state before rows reach the native virtualizer; authors retain match semantics and controlled values. Authors mark independently interactive accessories with `accessoryOutsidePressable`; theme injection, touch-target policy, overflow placement and group indexing remain adapter-owned |
| `Form`, `Form.Field`, `Form.TextField`, `Form.Toggle`, `Form.Select`, `Form.ValidationMessage`, `Form.Actions` | Real form semantics over the canonical action-form owner. Authors provide static already-resolved options; host option sources and account inventory remain host-owned |
| `Popover`, `Menu`, `Dropdown`, `ContextMenu` | Controlled overlay semantics over the incumbent presentation host. It owns anchoring, focus return, Escape, outside dismissal and Android Back; authors supply only semantic state and items |
| `SessionProvider`, `SessionTranscript`, `SessionComposer`, `SessionChat` | In progress. A host-mediated live Session (transcript, composer, approvals) rendered by Happier's own session view. One controller per provider and at most one of each part; parts fill a bounded region. RN/RNW only: isolated tests and hosted web render the author's `fallback` |

`./presentation` and `./environment` are the advanced public tier over the
shared implementation and its environment seam. They exist so Happier core and
plugin surfaces reach the same presentation owners; a core adapter may render
its own RN host only when a portable author contract intentionally excludes
required private props/styles. They remain less ergonomic than the root tier,
not host-only or plugin-private.

Spinner presentation belongs to `presentation/feedback/Spinner.tsx`:
`resolveHappierSpinnerPresentation` decides the mark and motion, and
`HappierSpinnerHost` renders that decision for both core and plugin adapters.
Dot timing belongs to `presentation/feedback/spinnerStyles.ts`: a resting style
plays its motion (first dot lit until the last dot is back at rest) at the
chosen speed, then rests for the chosen pause in absolute milliseconds;
continuous styles take the speed only. Frame tables are shared per style, speed
and pause, and native clocks per played cycle length.
The renderer preserves each host's styles and native color values. On Android,
the classic ring keeps its native widget and still overlay mounted together,
so pausing motion preserves the visible mark and native layout. On native
platforms, an explicitly stopped, hidden spinner keeps its layout slot and leaves
accessibility traversal until it resumes. Retained surfaces and inactive tab panels narrow
their parent's presentation activity through a private projection; this does
not change Resource or author work lifetimes or the public Surface Context ABI.

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
| `api-surface.json` | The machine-readable public surface, generated at pack time |
| `api-declarations.md` | The generated declaration listing, generated at pack time |

The three API-governance artifacts ship deliberately: they are the published
record of the public surface, and an author reads `API.md` from
`node_modules/@happier-dev/plugin-ui/` rather than guessing export names. No
`src/**`, test, fixture, or config file is included. Feature QA proves this
selection through source-owned inclusion tests and does not create or install a
local release archive.
