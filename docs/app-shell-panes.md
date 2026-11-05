# App shell panes

This page describes the unreleased 0.3 shell contracts under integration. The shell keeps a page's main content,
side panel, details workspace and bottom pane under one scoped owner. The left navigation column
has its own visibility owner; hiding a page's main column does not collapse navigation.

## Destination windows (0.3 development)

Native `app_window.rs` owns Session window creation, readiness, reuse, teardown
and restore records. `desktop/window/appWindowRuntime.ts` connects that lifecycle
to the existing workspace and draft owners. `session.open` with
`presentation: 'window'` delegates to `desktop.windows.open`. The window role of
the shared desktop host result determines availability; Electron is unavailable.

The same `desktop.windows.open` owner accepts catalog destinations and qualified
workspace and pane tabs. `workspace.tabs.list` publishes an address containing
Home, Account and layout, followed by either `tabId` or `scopeId`/`tabKey`.
Activate, move and close accept that address; legacy workspace `tabId` calls
retain their existing meaning. Pane addresses are pane membership, not invented
workspace routes. The shared workspace open-menu builder supplies window,
overlay and Happier presentation items to tab strips and sidebar rows.

Moving restores the way a relaunch does. The existing pane provider persists
Details tab state, including file draft text/base hash and view state, before
the selected body releases; its parent scope and siblings remain in place.
The recipient mounts the actual Details renderer and flushes that same owner
before Return restores source presentation. There is no cross-window editor
checkpoint API. Plugin runtime tab fallbacks retain the existing relaunch
behavior rather than transferring a live plugin closure.

Unpersisted authoring work uses its mounted Keep/Save/Discard guard before
moving or replacing the destination. A failed save or Keep leaves it editable;
secrets never enter window restore records. Team API credential creation fields
participate in this guard as well as the already guarded uncopied bearer.

A moved tab stays in its source window's layout and Account-shared membership.
Its device-local `presentation: {windowId}` hides its strip entry and body; the
native record set projects placement into every window on that Home and Account.
Secondary providers use the record's `layoutId`; the primary layout is `main`.
Full windows retain the existing Account-shared tabs with independent local layout.

`desktop.windows.open` with `chrome: 'full'` creates an independent full shell
from a Home, Session or catalog destination. Each implicit open creates another
window; an explicit window id focuses or retargets it. Its retained record uses
the existing layout id and an optional full chrome marker, with no copied tabs.
Secondary Home changes use tab-local selection and update only that window's
Home context. Main retains device selection. App-wide effects stay in main;
Tauri's native live-window order selects one responder for each Home: main for
its current Home, otherwise the earliest full window on that Home and Account.
Hosts without multiwindow support, including Electron, retain their primary
Home responder without acquiring the native responder projection.
The native File menu's **New Window** and Search's **New window** use that
invoking realm's Home with `chrome: 'full'` through the same window Action.
Window discovery includes empty shells; activating a window id preserves its
selected destination. Closing an addressed tab retains its full shell. The
mounted current-UI **Close window** command requests the native guarded Close.
Local Action settlement, keyboard navigation and Session presentation remain
in every full realm. Native focus projects its actually presented Session;
the initial restore address does not decide the current composer.

Full Close guards its mounted editors and flushes pending New Session fields and
local draft writes before destroying only that window. A failed write keeps the
window open. Quit uses the existing app-wide handoff and retains all full and
destination records for independent restoration. A full window whose saved
credentials are unavailable opens the existing Connect path. Native restoration,
platform chrome and loaded per-realm cost measurements remain release checks.

The recipient restores the existing Session draft repository before reporting ready.
Main forwards admitted Session presenter Actions once to that recipient; local
composer typing stays local. Each realm publishes its committed mounted RPC address
keys on the existing native app-window surface, without draft or editor contents.
The single Home responder advertises those workflow-draft, mounted Work, Session UI
and current-presentation command addresses. Placement forwards an admitted request
once to the presenting realm's actual registry, including workflow, plugin and file
editors; withdrawing a mount withdraws its address. Unmounted editors remain
unavailable and are never recreated to answer an Action.
The overlay's addressed draft adapter uses that same
presenter and publishes only changed composer snapshots while demanded. A person's
pinned-field edits use `applyDesktopSessionDraftTransaction`, then the existing
`applyMountedComposerPresentationTransaction` document owner, without approval.
Agent `composer.transaction.apply` requests retain the Action executor's required
approval. There is no new approval mode or bypass flag.
Return releases and flushes the recipient before the
source resumes. Native Close returns placed source tabs; closing a no-source
window creates no main tab. Ordinary Quit retains restore addresses and per-label
geometry. Failed restore releases the partial native window without retiring its
saved record or overwriting saved geometry; its error alert offers Retry through
the same restore owner, re-reading the record with current Home credential contexts
so a later logout cannot resurrect it. Placed tabs recover in their source layout.
Relaunch enumerates Home/Account scopes through `TokenStorage`'s existing
qualified credential reader, including Homes with different local Account ids;
each new realm still resolves its own credentials at boot.
Credential replacement retires the affected Home/Account pair. Explicit forget
also retires that Home's Connect windows, including records without a current
credential. Global forget enumerates every Home through the same `TokenStorage`
owner. After commit, its existing native notice carries only the affected Home
ids, URLs and mutation kinds to every app window. Each other realm replays that
notice through its existing local credential-change event, immediately stopping
the forgotten Home's multi-Home sockets and retiring its cached credentials and
encryption keys. Native derives the source window label so the originating realm
does not replay its own event. Main still refreshes and reveals. Account Directory
sign-ins do not replace Home credentials.

An Account switch or replacement started in a secondary first reveals and focuses
main and opens the existing sign-in there, before acquiring credentials. Outgoing
Account windows close after replacement succeeds; cancelled or failed sign-in
keeps them open. Credentials never cross the window bridge.

The real two-webview settings/relaunch probe passed. Loaded native arrival and
idle measurements are a named release check under N4 Amendment A2.2. The N4 U1
lane report distinguishes source checks from physical platform certification.

The notch's native frame owner publishes `frame.screenOrigin` (logical screen
top-left and `scaleFactor`) through the existing overlay state event. Overlay
layers read it with `useDesktopActivityOverlayField('screenOrigin')`; subtract
the origin from a logical Session-window rect to place it in the overlay.
`present.extent.screenBounds` optionally includes measured layer bounds in those
same screen coordinates. Native unions them with the island before retaining the
transition envelope, preserving the island anchor. Removing the bounds and
presenting `settled: true` shrinks the window after the transition. Unchanged
frames publish nothing. This is the development frame seam for Extract; N3 owns
the flight rendering and its live acceptance.

## Owners and callers

- `apps/ui/sources/components/appShell/panes/model/appPaneReducer.ts` owns scoped pane state.
  `AppPaneProvider` persists each changed scope through `sync/domains/state/filePaneUiState.ts`
  and the existing device KV adapter (`persistenceStorage.ts`). Open tabs, per-tab view state,
  draft checkpoints and main-column visibility are state, outside the settings document.
- `AppPaneScopeHost` is the composition boundary for Sessions, Projects, Workflows and app pages.
  It resolves effective main visibility and arrangement once, then supplies `PaneColumnsHost`.
  `AppScopePaneHost`, `DetailsPaneHost` and `DetailsPaneSlotHost` forward destination-owned data.
- `components/ui/panels/paneBreakpoints.ts#resolvePaneLayout` owns docked/overlay decisions.
  Callers inside a pane host consume its live layout rather than interpreting window width again.
- `panes/layout/paneSizing.ts` owns pane sizing roles. `SidebarNavigator` and `sidebarSizing.ts`
  own the independent navigation column.
- Plugin UI's `presentation/layout/resize` owns resize math, pointer reading and the accessible
  handle. Host pane adapters, SplitCanvas and collection rails consume this owner.

Session/Project remembered mobile surfaces and Project checkout selections use
`sync/domains/state/navigationUiState.ts` over the same keyed device KV owner, with exact-key
subscriptions. Surface keys retain their Account/Home qualification; checkout keys retain their
Home qualification. The Settings loader imports 0.2's Session-surface map once before removing
its old carrier. Existing current records win on a partial-copy retry, and a refused copy retains
the source for a later read. The three Project maps are 0.3-only and have no Settings conversion.

## Main column visibility

A host offers hide/show by supplying `mainColumn: { hideLabel, showLabel, identity }`.
The destination supplies its own name, mark and existing lifecycle presentation; the shell does
not infer a Session or Workflow state from a scope id. A host without this descriptor offers no
hide control. Session and Project headers supply their domain wording; app pages use their title.

`PaneScopeState.mainHidden` is a persisted preference, changed by the `setMainHidden` reducer
action. `usePaneMainColumn()` exposes the host's effective `hidden`, `canHide`, `folded`,
labels, identity and `setHidden`/`toggle` controls to descendants. It returns null outside a host.
An active presentation outside the host's descendant context, such as Session presentation intents, receives the same
measured controls through `onMainColumnControlsChange` and calls their `setHidden`. This also opens
a folded main drawer whose persisted flag may already be false; dispatching the persisted flag alone
cannot reveal that drawer. Explicit focus or return-to-Chat reports unavailable without published
controls. Ordinary Board opening beside Chat and item reveal retain their scoped pane navigation
when no main-column host is present, without creating a visibility fallback.

`AppPaneScopeHost` only hides main when the layout supports neighbouring content and a side or
details column is available. It clears stale hide state when the last neighbouring column closes,
including destination-owned details not represented in the reducer. A narrow single-column layout
keeps its usable main surface. The hidden main remains mounted through `RetainedPanelSurface`;
composer drafts, editor state, scroll and embedded browser identity survive hide/show.

`AgentInput` owns the shared composer-focus request used by keyboard commands, registered composer
targets and review handoffs. A request reveals hidden main through these published controls, then
focuses the retained field after the visible layout commits. An unpresented composer refuses the
request. Review handoffs separately close panes and select mobile Chat without sending or clearing
the review tabs; they do not own another visibility setter.

The visible main header owns the hide button. Once hidden, a restore chip in the neighbouring
column retains the destination's identity and current lifecycle presentation. The old route-bound
pane focus mode and its details-header controls are retired. Protocol presentation vocabulary stays
unchanged: `board.open` with `mode: 'focus'` hides main, `beside_chat` reveals it, and `chat.return`
reveals it while preserving the person's open panes. Item reveal preserves visibility.
The local-settings normalizer still removes the obsolete `editorFocusModeEnabled` input key;
that cleanup-only reader has no visibility control or current writer.

## Arrangement and geometry

The device-local `paneArrangement` setting selects Session first or Editor first. Session and
Project hosts opt in with `arrangement="honour"`; Workflows and app pages retain Session-first
order. Phones do not apply arrangement controls. The setting is exposed through the declared
`appearance.paneArrangement` Settings anchor.

Editor first makes details/editor flexible and retains an editor column even before a file opens.
The Session column has a remembered pixel width; the side panel folds first, then main becomes a
drawer when its minimum cannot fit. The layout resolver decides these transitions. `row-reverse`
and one `mirrored` fact change physical placement without reordering or re-parenting content.

Stored pixels are preferences; rendered pixels are clamped to the available pane budget. Window
changes, folding and hiding never write a clamped or zero width back to a preference. The navigation
column's default comes from the standard collection-rail role and does not grow with the window.
The local-settings normalizer migrates the former pixel/basis pairs once: old defaults at their old
basis become unset, other pixel preferences remain, and the basis keys are removed.

Every resizable column shares Plugin UI's resize primitive. Collapse is opt-in: navigation arms
only when attempted size passes half its minimum, and commits collapse on release. Passing slightly
below minimum only clamps. Other pane and collection rails do not opt into collapse. Double-click
resets through the owning column's default; geometry and persistence stay with that owner.

## Shell planes, right panel position and pane headers

`AppShellMaterialFrame` owns the shell's planes. The rail, title strip and navigation column stand on
one canvas plane (`appShellColumnSurface`, colour from `appShellColumnPlaneColor`); only the page is a
lifted, rounded sheet, with no outline and no column hairline. The page's seam shadow is an inert sibling
of the sheet inside the page slot, so it follows the column's drawn width (drag, rubber band, spring-back,
collapse) through ordinary layout. A peeked column floats in a body overlay right after the rail.
Settings and Home console columns use the same plane.

The device-local `rightPanelPlacement` setting (`canvas` default, `sheet`; anchor
`appearance.rightPanelPlacement`, set from Appearance and the Look panel, agents via `settings.set`)
chooses where a page's docked right panel and its action rail stand. `SidebarNavigator` reads it once;
the frame resolves it (`sheet` without chrome and off the web) and publishes the tail hosts and the
page's empty-tail width through `appShellTail.tsx`. `PaneColumnsHost` stands the docked right column and
the rail in the tail only for the one page on screen at the trailing edge (not Editor first, not one pane
of a split) and budgets its layout with the empty-tail width, so both placements resolve the same widths.
`AppShellTailSlot` keeps one container per column, so changing places moves it without remounting.
Overlay, in-main and hidden presentations and the details drawers stay in the page. On the canvas the
rail takes the plane's paint and the docked panel is a sheet of its own: content paint, the page's corner
radius, an 8 px canvas gap from the page and the window inset beneath it, drawn inside the column's own
width so it opens, closes and resizes with it. The rail's active action of that open panel is its tab: the
panel's material from the rail's inner edge, rounded away from the panel (`PaneActionRailContext`
`panelAttached`); elsewhere the active action keeps its edge marker.

Every sheet's rounded corners leave pixels the sheet does not paint. `appShellMaterialPlane.tsx` owns the
shell's sheet geometry and `AppShellSheetCorners`, which coats those cutouts once with the neighbouring
plane (masked to the outside of the curve, never behind a translucent sheet), so the desktop app's native
window material never shows at a corner. The tail paints no plane of its own: the rail coats its column
and the window inset is its own strip.

`PaneHeader` owns the pane header band (title, identity, facts, Back, close, an optional overline and a
phone navigation band); `DetailsTabHeader` is the one adaptive content/fit adapter over it, used by Session
(`SessionPaneHeader`, the data leaf), Discussion and the Details tabs. Entity headers pass
`actionsFit="compact"`: their controls stay beside the title and read the header's one fit result,
`DetailsTabHeaderActionsCompactContext`. Headers draw no bottom hairline; a scroll-linked shade appears
instead. `PaneHeaderScrollScope` pairs one header with its primary body; the body's scroller reports its
physical distance from the top (the shared transcript renderer, `ItemList`, a plugin `ScrollArea` through
the private presentation-host hook) and the shade's opacity is that distance over 12 px. Side panes, the
bottom pane and popovers are isolated from the main scope; outside a scope a header draws no shade.

## Openers and Actions

### Right rail placement

The right-sidebar catalog supplies each tab's default placement. Session essentials lead the rail:
Info, Work and People, followed by Changes, Files and Terminal. Project and Discussion rails consume
their own scoped catalog entries. Selection is separate from presentation order: an absent or stale
Session selection still opens Changes when available.

`mobileSurfacePinning.ts` owns effective placement for the rail, overflow, customizer and preview.
Catalog `auto` resolves to pinned only for known positive content; empty or unknown content resolves
to overflow. An active automatic tab keeps its rail slot. Explicit pinned, overflow or hidden
preferences win; choosing Automatic removes that item's override. Preferences never store `auto`.
Info permits pinned or overflow, so a saved hidden value resolves to its legal catalog default.
Reset clears only the edited surface, preserving composer and other placement preferences.

A rail with nothing standing on it takes no column: no pinned action, no open panel and no count or badge its
More could carry. It reports that through `PaneActionRailContext.onVacantChange`. Only a page whose rail stands
in the shell's tail, with the title strip's `AppShellTitleMoreSlot` present, gives its column up. `PaneColumnsHost`
then hides the column but keeps the rail mounted so it can report again, returns the width to the page, and hands
the focused page's rail that slot as `vacantMoreHost`. The rail's More moves there through `AppShellTailSlot`,
without remounting, inside the strip's measured trailing reservation. Everywhere else (native, Editor first, a
split pane) the column stays, because the More has no other home. Vacancy is read from placement, not from fit,
so a short window keeps its More in the rail.

Automatic built-ins read scalar facts from their existing resource owners. Services and Board reuse
received exact-scope summaries first; a mounted Session may acquire one missing scalar per resource,
without opening a pane, fetching bodies or starting a watch. Projects only consume already-held
facts. Problems and References passively select the held File controller; Scripts uses the existing
Work projection. Optional plugin counts use the contextual Resource lifecycle described in
[Plugin platform](plugin-platform.md).

Computer is a machine-group launcher rather than a selectable retained tab.
`useOpenSessionComputerScreen` owns its structural availability, opening and disabled reason across
the rail, header/menu, presence line and transcript references. A retained offline Machine keeps
the launcher disabled; missing viewer or Machine identity omits it. Opening still uses the mounted
Session presentation owner and grants no capture or control consent.

`RetainedPanelSurface hiddenMode="activity"` opts into React Activity suspension after first open:
hidden effects disconnect while local editor state survives. Never-opened content stays absent.
The existing default retention and explicit Freeze policy remain available for their current
consumers. Info's body and disclosure composition opt in through this same surface owner.

A hidden retained surface (`display: none`, a hidden Activity) reports width 0 to every `onLayout` below it.
Measuring consumers admit a reported width only through `readHappierVisibleLayoutWidth`
(`@happier-dev/plugin-ui/presentation/pageMetrics`), which returns `null` for a hidden box, so they keep their
last visible measurement until a real resize. Do not hand-write `width > 0` guards or recompose for a zero.

Openers request a destination kind through the existing pane adapter. An implicit open does not
move an already-open tab. Details retain their existing preview/pinned and split-workspace owners.

`shell.column.get/set` address `navigation` (the default), `main` or `side`; `tab` on a side-panel
set selects an existing built-in or plugin tab and opens that panel. Main visibility uses the inverse
of `mainHidden`. Arrangement uses `settings.get/set` on its declared anchor. Widths remain continuous
geometry controls rather than Actions. These reversible view Actions retain their existing default
approval policy; per-Action user settings still apply. See [Actions](actions.md).

Resizable collection widths and presentation-host bindings are documented in
[Collection presentation](collection-presentation.md); installed-plugin ownership is described in
[Plugin platform](plugin-platform.md).
