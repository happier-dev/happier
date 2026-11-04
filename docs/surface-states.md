# Surface state composition

Use one state composition for a page, pane, details area or compact list line. A surface explains what is happening and offers the next useful action; retained data stays visible while its owner refreshes it.

This page describes **0.3 development source**, not completed platform or live-fidelity certification.

## Retained workspace destinations (0.3 development)

The Account's `workspace:tabs:v1` record shares intentional open-tab membership,
order, pins and split membership. The local `workspaceLayoutV1` owner retains
window/device layout, active tab/group, MRU, maximize and destination presentation.
Receiving a shared record is not a navigation command: an already-open tab keeps
its destination target and instance, including an unsaved editor. A newly arriving
singleton cannot replace an existing local instance merely because the peer used
another tab ID. Remote additions remain discoverable without changing local focus.
The existing tab-sync owner maps that retained local instance to its canonical
shared ID for membership, pin, Close, order and split-pair edits. Its destination
contents and mounted identity remain local; this correspondence is not persisted.

If a peer closes a currently visible tab, the local workspace keeps that instance
in its pane; it does not reopen the tab in the shared record or write a layout in
response. Local navigation reconsiders the already observed shared record and
removes it once the pane leaves it, including visible unfocused split panes.
Background removals still follow shared membership. Explicit local navigation,
Close and pin/reorder edits remain owned by the existing workspace navigation and
intent/CAS owners. No extra handoff document or seed replay store is involved.

The workspace provider observes the browser's existing history-change signal;
an external URL commit does not wait for an unrelated Account publication to
admit its destination. Expo route entries consult the same owner's route
admission for their own pathname before lending an editable body to Expo, even
when that scene renders ahead of the browser-history mirror. Retained hosts
continue to own the document after admission.

A cold Session's Home qualification dispatches through the deepest mounted Expo
navigator. A parsed child state without a navigator key is not a dispatch target:
replacing its `index` at the parent would select Home and lose the Session path.
The installed Expo routing patch preserves that distinction while lazy layouts
hydrate; mounted child navigators still receive their own navigation actions.

## Core and shared owners

The app consumes [`SurfaceStateCard`](../apps/ui/sources/components/ui/surfaces/SurfaceStateCard.tsx) through `@/components/ui/surfaces`. It admits empty, loading, success, error, warning, unavailable and denied states, with translated title/reason, a primary action, optional quiet secondary action, note/help, present-tense live information and diagnostic details.

[`SurfaceStateSizeProvider`](../apps/ui/sources/components/ui/surfaces/surfaceStateSize.tsx) sets `pane`, `details`, `page` or `phone` once at the container, or `line` for a narrow column whose states are one line under their header (the widget frame sets `line` in the Companion and other columns and `pane` on Home and Boards). `useSurfaceStateSize` still reports only the sized steps, so a line column hands plugin surfaces no size. A card's explicit size wins; outside a provider the existing unsized composition remains. `size="line"` is the compact in-list composition. Shared size/type/line metrics come from [`presentation/state/InfoState.tsx`](../packages/plugin-ui/src/presentation/state/InfoState.tsx); change that owner rather than hand-sizing a consumer.

The composition itself (which parts appear, their reading order, action layout, the compact line's inline recovery, where the live region sits and when a diagnostic becomes a disclosure) has one owner: [`HappierSurfaceState`](../packages/plugin-ui/src/presentation/state/SurfaceState.tsx). `SurfaceStateCard` is core's adapter over it: it binds core typography, `RoundButton`, glyphs and the `EmptyState` tile, and keeps the content-replacement report, the iOS announcer, the "Still waiting" clock and translations private. A diagnostic disclosure stays outside the live region, so expanding Details announces nothing new.

**The kit, one owner per state** (lab `.happier/design-lab/empty-states`, concept `es-kit`):

- **Loading, shape unknown:** `SurfaceStateCard kind="loading"` (`PaneLoadingFallback` binds it), plugin `LoadingState`. A ring over its words as one quiet body line; `HappierSurfaceState` passes `quietTitle` to the tile, because a wait is not an event and never takes a heading's weight.
- **Loading, shape known:** `SkeletonRows` / `ItemLoadStateRows`, plugin `LoadingState rows`, over `HappierSkeletonRows`. A domain placeholder (a chart, code lines) composes `HappierSkeletonBlock`; nothing draws its own pulse.
- **Empty:** `EmptyState` with a `scene`. `layout="page"` under a page header, `layout="centered"` in a detail with no header, `layout="line"` among rows. An empty state's art is a scene, never a live surface.
- **Out of reach:** `HomeReachabilityGate`, the one owner of "this Home does not answer". `variant="pane"` replaces a surface; `variant="line"` is the one offline line, drawn by `SurfaceFreshnessLine`, and a page keeps it mounted with no children above content that waits on the Home (Usage, Home). A read that failed for the same cause defers to it (`useActiveHomeUnavailable`, `useFailureExplainedByUnreachableHome`). Plugins use `FreshnessLine icon="unavailable"`.

Plugins use the public Plugin UI state components. Public `SurfaceState` is the plugin adapter over the same composition, and `LoadingState` and `ErrorState` (with `onRetry`) render through it; both adapters also consume the shared state frame, compact line and diagnostic disclosure renderers in `InfoState.tsx`; placement and disclosure are not consumer-owned copies. App-specific `SurfaceStateCard` is a host composition, not permission to import app internals into a plugin or claim all its props exist on each public component. Exact public props are package-owned. Public `ErrorState` distinguishes error, unavailable and denied states and supports compact lines. Static failure states stay silent by default; a caller can explicitly request an announcement for a lifecycle transition, without announcing the diagnostic disclosure again.

In a grouped half-width widget, a whole-body empty state uses compact body room and a line composition. Host bodies declare this with `SurfaceStateCard.replacesContent`; supplemental missing-data notes leave it unset. Native `WidgetFrame` empty bodies declare it automatically. The frame consumes the group layout owner's content projection without changing the saved size, the body's semantic size or the group's packing topology. Loading, retained content and standalone frames keep their existing sizing.

### Empty-state scenes

In 0.3 development source, the state's mark slot can draw a Daybreak scene (widgets plan A5 and its library extension) instead of a glyph. [`presentation/state/scenes.ts`](../packages/plugin-ui/src/presentation/state/scenes.ts) is the one scene registry. A scene is data, `{ horizon, moment, planet, planetAt, props[], sky[], accent }`, composed from named parts:

- 11 horizons;
- 7 moments, which place and light the planet;
- 7 planet states;
- 51 single-stroke props, each placed with `x`, `ground`, `scale` and `flip`;
- 6 sky marks.

The registry enforces the composition rules per size: 3, 2 and 1 props and 2, 1 and 0 sky marks at page, pane and thumb, with detail dropped at thumb, and one accent. The 37 built-in scenes (`HAPPIER_SCENE_IDS`) are compositions of these parts. Plugins compose theirs through the same public API (`defineHappierScene`, `defineHappierSceneProp`). `resolveHappierSceneArtSize` decides which states draw a scene: centred or page states with room. Line and inline states keep their glyph.

`planetAt` uses the same 160 × 64 scene coordinates for `x`, `y` and radius `r`, with `rise` placing the planet above the ground when `y` is omitted. Its optional `style: 'airy' | 'balanced' | 'rich'`, `fullness` and `digits` choices are rendered by SceneArt through PlanetCanvas's Brand scene core, including explicit `false` and `0`. The canvas covers the scene so the digit field can extend beyond the limb, while the scene retains its ground clipping and one-shot rise. Omitting all look fields preserves the existing mark calibration; both paths use the same host canvas.

Core's `EmptyState` and `SurfaceStateCard` take `scene`. The public plugin `EmptyState` takes it too and draws through the presentation host's `renderScene`. Both reach the same host renderer, [`SceneArt`](../apps/ui/sources/components/ui/surfaces/SceneArt.tsx). It owns:

- the line ink and widths, from theme tokens;
- the accent and the "needs you" beacon, in the attention amber;
- the Brand planet through `PlanetCanvas` (the scene core for authored looks; `createPlanetDots` with the calibrated lattice, halo, warmth and out-of-reach ink for default marks);
- the one-shot rise of a `rising` planet, which stays still under reduced motion or when the surface is inactive.

Callers choose a scene; they do not draw their own empty-state illustrations.

"Needs you" uses one amber everywhere: Brand's `PLANET_ATTENTION_HEX` feeds the app theme's `state.attention`, the status cell (`createPlanetStatusCell`) and scene beacons. Rose is for failure only.

Notices above retained content share [`HappierBanner`](../packages/plugin-ui/src/presentation/content/Foundation.tsx): the app's `AttentionBanner` binds its theme, actions and diagnostic disclosure, and the public `Banner` binds plugin text and glyphs. The shared renderer owns the tint, outline and responsive action placement. Whole-surface states continue to use the state-card composition. Its `strip` presentation is the compact band across the top of a pane or reading surface (the walkthrough's failure, partial-review, refinement Undo and ended-conversation bands): freshness-line measures, ink hairlines in every tone, a title that leads only when a description finishes the sentence, quiet word actions before the one button, and actions that wrap beneath the words and end at the trailing edge on a narrow pane. Domain owners such as `ScmDiffSummaryFailureNotice` keep their typed classification and copy and draw through `AttentionBanner presentation="strip"`; there is no separate notice family.

Public `Status` and its shared
[`HappierStatus`](../packages/plugin-ui/src/presentation/status/Status.tsx) own
labelled status rows. The default notice is a polite status region; the explicit
`presentation="inline"` variant is one truncating metadata line without live
announcements. Triage cells consume that variant while retaining their domain
state classification and the row's complete accessible description.

Public `RowStatusLine` and shared `HappierRowStatusLine` own compact status
metadata under a row title in 0.3 development source. Agent and Computer Use
rows bind their existing host primitives to that shared composition. Quiet
states show words; warning/failure states add a coloured dot and words. Busy
work may show its spinner alongside the trouble indicator and one inline
recovery link. Domain state, copy and operation lifecycle remain caller-owned.
This compact variant preserves its truncation and independent action rather
than becoming an announcing notice.

Permission requests in Session chat and Triage share
[`HappierApprovalPromptChrome`](../packages/plugin-ui/src/presentation/interaction/ApprovalPromptChrome.tsx).
The host adapter and public `ApprovalPrompt` bind their themes; callers retain
preview facts, answer controls, admission and decision lifecycle. Presentation
does not acquire permission authority.

Tinted status labels share `HappierBadge`: core's `StatusPill` and public Plugin UI `Badge` read the theme's `state.<status>.textForeground` role for their words and counts. Markers and icons retain `state.<status>.foreground`; plain and outlined labels retain their existing ink. The public theme snapshot projects the text role as optional `statusText`, so older snapshots keep their existing badge colour. Default light/dark text is AA on the tinted status surfaces. Appearance profiles remain unclamped: an existing foreground override also supplies the text ink unless the profile explicitly overrides the text role, and explicit component foregrounds remain exact.

Progress and capacity bars share `HappierProgress` in the same presentation module. The app's `MeterBar` supplies the domain's fill and colours; a capacity meter stays silent while named progress reports its value. Numbered setup and checklist markers share [`HappierStep`](../packages/plugin-ui/src/presentation/content/Step.tsx) and its marker renderer. Adapters retain their own step decisions, labels, actions and details.

## Surface material (development)

Public Plugin UI `Surface` and `Card` accept `materialRole="chrome" | "sidebar" | "content" | "card" | "floating"`;
`Surface` defaults to `content`, while `Card` defaults to `card`. They consume the existing shared
`HappierSurface` presentation owner.
The same-realm host renders native material through its incumbent glass owner. Unhosted native
surfaces retain their base color. Web background paint consumes the host's role opacity variables,
with an opaque default when that projection is absent; text and child controls do not inherit a
material opacity. Nested surfaces of the same role consume a separate nested coat projection to
avoid accumulating tint. Material presets, preferences, OS overrides and native availability stay
host-owned; the public role does not introduce another material policy or a wire capability.

The app's policy is [`glassMaterial.ts`](../apps/ui/sources/components/ui/glass/glassMaterial.ts),
with one Account-synced five-group table. Settings presents it as Window (`content`, the app over
the desktop), Title bar and rail (`chrome`), Sidebar (`sidebar`), Elements (`card`) and Menus and
dialogs (`floating`). A browser cannot show the desktop. The presets sit above one Glass/Solid
row per layer; blur strength stays global. The protocol's
[`glassPreferenceMutations.ts`](../packages/protocol/src/actions/settings/glassPreferenceMutations.ts)
owns preset coats, tolerant reads and deltas. Preset detection allows the independent Elements
Glass/Solid toggle; an authored Elements coat makes the table Custom. Preset switches
preserve its Glass/Solid choice. Tables without `card` derive it from their preset, using Auto for
Custom. Numeric Elements writes carry optional `authoredOpacity: true`, so even a value equal to a
default coat remains authored; the Glass/Solid toggle and enabled named presets replace that intent
with their default coat. Solid masks it without erasing it. The marker is part of the undeployed
0.3 table, not a new 0.2 scalar input.
Solid removes glass; Auto uses the W3 layered whole-app coats on a supported desktop and
floating surfaces on phone/browser; Everywhere uses one coat for chrome, sidebar and content. In 0.3 development,
Auto, Everywhere and Clear share Strong/2% floating material, independent of the surrounding
intensity choice. The Account setting `glassTintIntensity` is an integer 0–100 slider, default 12.
The single interpolation owner is `resolveGlassTintValues` in
[`glassTint.ts`](../packages/protocol/src/account/settings/glassTint.ts): anchors 0/50/100 retain the
former Subtle/Medium/Strong values. Elements coats are 1/25/45% (Clear: 1/15/30%); menus are 1/2/25%.
Every coat and compression value interpolates linearly between neighbouring anchors; default 20
gives Elements 10.6% (Clear 6.6%) and menus 1.4%. Stored obsolete strings read as 20; mutations reject
non-integers and values outside 0–100 without clamping. `readGlassTintedMaterials` consumes this mapping.
The stored per-group table never changes with the tint, so preset matching and
custom tables are unaffected; Solid groups stay solid and native renderers keep the stored (Medium)
coats. Web floating and Elements paint composes one coat over the 24px-blurred backdrop, owned by
`resolveGlassBackdropMap` (`glassMaterial.ts`). Before saturation and clipping its affine form is
out = (1 − α)·(s·X + t) + α·C: the tone is
`brightness(s)` (plus a neutral `invert/brightness` lift t only when the coat alone cannot reach the
target) and `saturate(1.05)`. Over the plain page the result is the surface's solid paint
(`edge.cardFill`, `edge.floatingFill` or an authored fill) at every tint, with C solved per channel so
the warm hue is kept. The solve includes saturation and filter clipping. When a saturated authored
fill cannot fit the named coat, it adjusts the effective web coat just enough to
reach every channel, removing the lift when that permits a thinner feasible coat. It still lands on
the authored fill; custom material tables remain exact. At the 0 anchor, glass never takes a neutral lift: when its 1% hair cannot
reach the paint, the coat thickens and the brightness is re-derived at that coat, so k stays exact.
The preferred compression k = (1 − α)·s comes from the same `glassTint.ts` anchors: dark 1 over an ordinary page for
Subtle and Medium (the page shows through, as in monocode); Subtle stays at 1 over a picture too (monocode's blur:
inside luminance within ±5% of the blurred backdrop in light, moved only by the paint step in dark); over a picture
Medium .45 and Strong .35 (primary ink keeps 4.5:1 over the balloons' bright sky); Strong .7 over a page; light .43
(.3 Strong), hung from white, and every light k is at most 1 − α so the backdrop is never brightened.
At default 12, k is .863 in light (plain and picture), 1 in dark over a plain page and .868 in dark
over a picture. Neutral lift is allowed only when k < 1 − α; otherwise the coat carries the paint.
The fixed-point and dark wallpaper shell branches do not use
`contrast()`, because it lifts dark backdrops toward mid-grey; the light wallpaper shell still uses
it in its white-anchored tone. Secondary ink would measure about 1.7–1.9:1 over the brightest sky, so backed glass
strengthens it (below) rather than dimming the picture to a slab. Wallpaper chrome and sidebar planes keep
their heavy coat over a `brightness(.65)` tone in dark. Panels pass `floatingRole="panel"` to `GlassSurface`
(`ModalCardFrame` for dialogs and phone sheets; `FloatingOverlay role="panel"` for large anchored panels such as
Add widget, the widget flows, Workflow run inputs and Board settings; menus keep the default `menu` role and its
hair, owner 2026-10-16): the protocol tint anchors give panel coats .55/.7/.85 at 0/50/100
(default .61), painted
as a fixed `color-mix` coat with k ≤ 1 − α and the coat solved so a plain page lands on
`edge.floatingFill`. Faint ink: a translucent Elements or floating `GlassSurface` with a band,
wallpaper or live desktop behind it redefines `--colors-text-secondary` for its subtree as
`color-mix(in srgb, <text.primary> 70%, transparent)`, so every stylesheet consumer of secondary ink
follows; nothing is set on ordinary pages or unbacked glass. Components that read the theme colour in
JavaScript and inline it (for example `SectionActionButton`) do not follow the variable.
Native Liquid Glass adapts itself and
the existing blur fallback uses its dark/light tint. Clear also lowers the other groups' coats;
Auto remains the default. The shared Settings and Actions material binding writes the
same five-group table, without another persisted mode. Custom opacity runs from fully transparent to
solid without legibility floors or contrast overrides. Code, terminal, diff and message
backgrounds inherit the content material rather than introducing near-solid reading fills.
Elements cover in-flow cards, card-framed widgets, the composer, settings groups and sidebar list
groups. The stored/native Medium coats are 25% in Auto and Everywhere and 15% in Clear, with strong
blur at any intensity. Effective web coats follow the Tint table above (a 1% hair at default Subtle);
their coat colour is solved by the same fixed-point owner. Sidebar- and chrome-held Elements are
backed only by a glass plane over a wallpaper or the live desktop, and paint the page colour. The glass owner resolves Elements solid with exactly their original paint
when no atmosphere band or wallpaper is behind them and the effective content plane is opaque.
Glass therefore means glass where a backing can show through. Reduce Transparency and inactive
windows still force solid. Native Elements use translucent tint without mounting per-card BlurView
or Liquid Glass views; web uses the existing backdrop paint. A card inside a content plane has its
own material, while nested cards in the same group inherit the coat and finish without stacking.
Same-realm plugin surfaces delegate material paint to the host renderer; web surfaces consume its
material variables. The public theme does not serialize another glass table. Embedded composers
use the same Elements role under the root `GlassMaterialRuntime`; `embedStyleTheme` applies their
theme and finish through the existing theme runtime without introducing a material policy.
An atmosphere behind the working page is a runtime input, `atmosphereBehind: none | band | wallpaper`.
The glass paint owner clears the content plane and its inherited page background whenever a planet
or picture is shown, under every glass setting. Background and glass are independent: Wallpaper
keeps its full-window layout under Solid, Auto on web, inactive windows, Custom and Reduce
Transparency. Functional surfaces retain the resolved material: title bar, sidebar, cards, widgets
and composer stay opaque under Solid and Reduce Transparency. The atmosphere layer supplies the
page colour outside its artwork. Cards, widgets and composer consume Elements from the glass owner;
atmosphere supplies the backing input without adding a separate material decision.
Wallpaper chrome and sidebar blur on inert sibling layers when their material allows it, using the same radius and tone
owners; their content ancestors never acquire a backdrop filter that cuts off nested popovers.
Session transcripts remain opaque by default even while another visible pane carries the atmosphere.
With the atmosphere's Behind sessions option, the content owner instead supplies a sibling reading
coat: the existing content blur and 56% light / 66% dark opacity for named translucent materials.
Custom opacity and blur, Solid, inactive-window and Reduce Transparency resolution remain authoritative.
Phone composers, including a selected workflow, also consume Elements; ordinary dialogs and
sheets use the floating owner through `ModalCardFrame`.
Native material changes replace only the background, preserving child input/scroll state.
Containing material roles reach shared and core field, row and control paint through
`HappierMaterialRoleProvider`: opaque inner fills become theme ink over glass, while authored alpha
fills and effective solid surfaces retain their original paint. Solid-control paint (primary fills,
their contrasting labels and gradients, disabled primary fills, and selected segmented thumbs)
is exempt at the shared material colour resolver, on both core and plugin surfaces. Controls supply
the semantic paint role rather than classifying a fill by its colour value. Disabled glass surfaces publish the
solid paint decision too. Native adapters consume the same host resolver; unhosted native surfaces
do not invent a material policy.
Web floating motion uses the existing overlay motion owner to animate unblurred content, leaving
the material sibling still. An opacity fade on its ancestor would establish a CSS backdrop root;
the settled content keeps no retained transform. Plain, nonmaterial overlays keep their frame motion.
OS Reduce Transparency preserves the stored choice but resolves solid with a visible reason.
Desktop and Android expose the OS accessibility destination with an observable failure result;
an honest iOS settings destination remains unresolved in the current build lane. Browsers observe
the standard reduced-transparency media query where available. Native inactive windows also
flatten. The main-window owner reports successful
native backing before the web root clears its opaque canvas. Blur Off can retain transparent
backing. The 0.2 enable/intensity keys remain inputs; the old device-local backdrop switch is no
longer a second runtime decision.

Soft finish remains one theme ink in
[`raisedEdge.ts`](../apps/ui/sources/theme/raisedEdge.ts). Dark defaults derive its hue and saturation
from the card fill, raised to 80% HSL lightness at peak alpha 0.025. The finish is a fixed 32 px band
(`SurfaceFinishGradient.band`), drawn by `happierSurfaceGradientWebStyle` (background size/position) and
`HappierSurfaceGradientLayer` (a native strip): dark lights the top edge, light shades the bottom edge to its
0.024 ink, and the rest of the surface is flat whatever its height. Primary and secondary button finishes stay
full-height (buttons are short). Authored `effect.surfaceFinish` colour and alpha apply as set;
Flat adds no finish overlay and preserves the existing fill, border and edge.

Mounted web roots paint HTML, body and the app root through
[`useWebRootCanvasPresentation`](../apps/ui/sources/theme/useWebRootCanvasPresentation.ts),
which subscribes to the canonical theme. The main window supplies its existing
native-backing decision; embedded roots use a solid canvas, and desktop overlay
windows retain their own transparent presentation. Theme-profile changes do not
imperatively repaint those web canvases. Startup paint remains pre-mount, while
native root and system-background updates remain profile-runtime-owned.

## Loading indicators

In 0.3 development source, loading bars and the transcript first-paint shape share
`HappierSkeletonPulse` in [`Skeleton.tsx`](../packages/plugin-ui/src/presentation/feedback/Skeleton.tsx).
It uses the existing CSS skeleton pulse on web and the native animation driver elsewhere.
The transcript supplies active-view and reduced-motion facts; its geometry and readiness remain transcript-owned.

In 0.3 development source, Sync publishes `isDataReady` when the first Settings
and Profile bootstrap attempts settle. Settings still precedes the independent
Sessions inventory, whose hydration and metadata upgrades do not delay workspace
restoration. The workspace publishes its scoped Session route anchor before
restoration; after Settings applies the client encryption requirement, Sync starts
that Session's coalesced exact read while Profile can still be pending. The
inventory and peripheral acquisition yield until that read settles, including its
key opening, without delaying core readiness. List queries, visible-row hydration
and reachability/reconnect recovery share that same foreground phase, so none can
start competing inventory or draft recovery while the routed read is pending.
This phase does not wait for Profile or Account-wide draft readiness.
Settings-triggered Authoring Memory and Project-row acquisition, Saved Secret
catalog materialization, Action-owned Artifact reads and Workflow Run list
projections also join this Sync-owned phase before opening unrelated content.
Their existing scoped loaders keep ownership of freshness, cancellation
and retry; they do not create another startup queue. Foreground key admission
does not by itself guarantee that the routed body has rendered.
An exact-read failure preserves the
route's retry state and lets background acquisition continue. A failed core attempt exposes the existing sync-error
state immediately; the same queues continue recovery. Startup observes
`invalidateAndAwait`, without a queue-drain deadline. Machines, Artifacts, plugin
availability, purchases, pets and independent background lists do not delay this publication. Machine inventory
loading and settlement come from the per-Home `machineListStatusByServerId`, so
core readiness alone never means there are no Machines. The workspace can restore
retained tabs without waiting for the Account-wide draft collection or
pending-message recovery. The separate
`isSessionDraftsReady` fact belongs to the same Sync owner and describes the
Account collection. Editable hosts use `SessionDraftHydrationBoundary` to request
only their own addresses after the same runtime preparation and legacy migration;
they can take custody while unrelated draft pages continue in the background.
Workflow definition seeds need preparation but no Session draft read. New Session
hosts hydrate an explicit draft or remembered ordinary-entry draft before choosing
their identity. Exact reads share the repository's reconciliation, durability and
in-flight read owner; inactive Homes retain their scoped invocation authority.
The existing local-draft fallback still applies when a read fails. Warm refreshes
retain admitted editors, while Account retirement withdraws admission. Both
Account facts reset when authority changes. Outbox recovery remains ordered after
the full draft hydration attempt, even when a foreground editor is already usable.

Session list acquisition and full Session hydration are separate in 0.3 development.
The list owns its ordinary and attention page frontiers; neither automatically
drains continuations without page demand. Activity membership retains truthful incomplete
coverage instead of exhausting every page in the background. Actual virtualizer
visibility publishes scoped list-row demand through `sessionSurfaceVisibility`.
Sync batches newly visible rows through the same coalesced exact reader used by
routes, without subscribing their transcripts. Running agents, attention facts,
report relationships and persisted scroll positions alone do not demand full
Session content. Routed Sessions, mounted content consumers and explicit operations
retain their own reads. Hidden row changes keep their list projection until a
consumer demands fresh detail; list visibility is distinct from transcript
visibility and human presence. Explicit metadata inventories and owner operations
retain their scoped acquisition semantics.

Unopened row identities reserve their existing avatar, title and path slots with
still placeholders. Metadata absence alone does not start a presentation clock:
demand may legitimately remain absent while the list projection is retained.

Content demand does not authorize skipping access reconciliation. An authoritative
withdrawal must retire the exact Home's retained Session and list memberships even
when no content consumer is mounted; refreshing a partial list head alone cannot
prove that an older retained row remains accessible.
Secondary-Home head refreshes reconcile retained rows omitted from that head
through the canonical exact access reader, without opening Session content. Exact
absence retires the Home-qualified row and every membership through the shared
retirement owner. A failed read preserves the row and exposes failed freshness
instead of treating transport failure as lost access.

Workspace core readiness admits the first scoped layout restoration. Once
`useWorkspaceState` has restored that Account/window, a later pending core
publication retains its layout and mounted destinations; a different or
unavailable scope withdraws it. Draft and feature owners still decide whether
their own content can be admitted, and navigation mutations remain disabled
while core readiness is pending. Late local-layout settings publications do
not replace a mounted editor or replay its consumed navigation seed.
Once scoped layout restoration admits a retained route, transport initialization
does not become another hydration barrier when a phone-width layout remounts.
On authenticated web routes awaiting onboarding teardown, the canonical
presentation owner marks the workspace deferred. Its route-entry loading mirror,
not a temporary editable Expo body, waits for the retained host. Deliberately
excluded public/overlay presentations and native phone routes keep Expo/stack
ownership; deferred admission does not enable the workspace or bypass draft
and feature decisions.

Plugin Settings and App deep links pass their existing `PluginSurfaceFallback`
skeleton to the workspace route-entry owner while Account/workspace hydration
is pending. The temporary editable page stays unmounted until the retained route
can own it. This changes the placeholder, not the hydration or request lifecycle;
the page renderer still awaits its actual loader outcome without a new timeout.
The root auth gate redirects signed-out protected plugin routes to the existing
welcome/sign-in route before mounting their bodies.

In 0.3 development source, core's `ActivitySpinner` and plugin `Spinner` share the frame generation and platform renderers in [`presentation/feedback`](../packages/plugin-ui/src/presentation/feedback/Spinner.tsx). The default is the eight-dot Happier mark: the seven-dot H plus a bottom-centre dot. Appearance retains each seven-dot H motion as an `h…` choice, alongside the Classic Ring. Shape is part of the shared style descriptor; consumers do not add their own dot or animation.

Core injects device-local style, speed and pause preferences, including pending release previews through the existing presentation host. Mounted plugin surfaces receive the same preferences in the optional `SurfaceContext.theme.spinner` presentation data; public `Spinner` and busy controls consume them through the shared environment and renderer. Contexts without these preferences use the shared default. Both preserve paused marks, reduced-motion breathing, explicit color overrides and the existing native clocks/web filmstrips. The host remains the sole owner of reduced motion and active-view policy. This addition belongs to the unpublished 0.3 development author contract: new readers accept omitted preferences, while prior strict theme readers reject the new field.

## Retained content and recovery

In 0.3 development source, Plugin UI `State` consumes the `PluginUiResourceSnapshot` returned by the Resource hooks directly. An admitted value stays mounted during refresh or failure; `FreshnessLine` shows pending work or the retained failure beside recovery. Without a value, initial loading and failed reads use the shared state components, and `onRetry` invokes the consumer's canonical refresh. The consumer declares emptiness with `isEmpty`; the presentation does not infer it from Resource bytes. Standalone author `SceneArt` uses the same scene registry and mounted host renderer as empty states.

[`SurfaceFreshnessLine`](../apps/ui/sources/components/ui/surfaces/SurfaceFreshnessLine.tsx) presents the retained observation's time, refresh/reconnect reason and optional recovery action. Show it alongside retained content, under the header; when there is no retained content, show the appropriate loading/error/unavailable card instead. It and the public Plugin UI freshness component consume the same `HappierFreshnessLine` renderer and freshness-text formatter. Domain adapters still own observation timestamps and recovery actions.

Loading narration and diagnostic disclosure belong to the composition. The card does not own retries, availability, permissions or the underlying request lifecycle. Supply truthful state from that domain's owner, stop live activity at its terminal outcome and keep technical codes behind details. Avoid a second consumer-local spinner/error parser or timer for the same work.

In 0.3 development source, the shared plugin-surface reason projection explains typed Collection conflicts, Resource admission failures, host-access disclosure mismatches and transport failures. Resource adapters may carry the cause in diagnostics beneath a generic unavailable envelope; only known diagnostic codes select product copy. Retained declarative documents keep that specific cause and use the same recovery selection as initial plugin views. Retry invokes the owning read or mount attempt; repair invokes the route's existing plugin-management callback, and a missing callback never creates a button. Artifact byte sources preserve bounded transport failures while continuing through the existing source order; successful fallback still wins, and integrity refusals take precedence when acquisition fails.

In 0.3 development source, a configuration page can pass `pageNoticeActive` to its existing `ItemList` when one notice explains a shared failure. The page renders that notice after its identity; `usePageNoticeActive` from [`listPresentation.tsx`](../apps/ui/sources/components/ui/lists/listPresentation.tsx) lets sections omit only repeated states with that same cause. Independent failures remain visible. Nested list and floating/grouped scopes reset the fact, so menus and separate lists retain their own explanations. This is presentation context, not request state or execution authority.

The Plugins page owns retained-snapshot recovery notices for its collection and adjacent detail pane. Routine refresh keeps prior content quiet; failed reads retain one actionable notice. A standalone plugin page owns its own notice, and a cold detail without prior content keeps the loading state.

Retained Plugin UI projections admit renderers against the bound controller's structurally installed Host API methods, separately from live invocation availability. Same-Account retained data can keep a page mounted with context and navigation available while effects return retryable `unavailable`; it does not grant fresh execution or semantic publication authority. Account, parent or containing-document retirement clears structural admission through that same controller, rather than borrowing another mount's authority.

The interaction boundary also accepts the renderer's content-readiness fact: an
already loaded RN module or inline HTML can render read-only on a cold mount
while effects remain unavailable. Without loaded content or an earlier live
paint, the boundary shows the cold state. Interaction availability alone is not
proof that content is absent.

Plugin Resource hooks retain their store snapshot when host mount activity turns inactive, release their read/watch subscription, and refresh through the same owner when activity resumes. Providers without a host activity fact keep their existing live behavior. Imperative `hostApi.watchResource` subscriptions remain caller-owned until disposal; view consumers should use the Resource hooks rather than create another presentation-driven polling lifecycle.

The shared Plugin UI `useSessionState` / `useSessionStates` hooks consume that same host activity eligibility. They retain the last ready Session snapshot while inactive, release watches and pending reads, ignore retired callbacks, and re-read on reactivation. The host's `readSession` remains the snapshot authority; these hooks add no cache, timer or Session status classifier. Providers without an activity fact remain live.

## Related

[Collection presentation](collection-presentation.md), [Plugin platform](plugin-platform.md), [DESIGN.md](../DESIGN.md), [UI instructions](../apps/ui/AGENTS.md).
