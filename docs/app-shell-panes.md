# App shell panes

This page describes the unreleased 0.3 shell contracts under integration. The shell keeps a page's main content,
side panel, details workspace and bottom pane under one scoped owner. The left navigation column
has its own visibility owner; hiding a page's main column does not collapse navigation.

Hosted Machines layouts inherit the selected section for every registered child.
Preset creation and editing use their existing Settings URLs inside the
Machines detail area; the Machines column remains the single machine list there.

The workspace navigation adapter holds the selected app section for its mounted
lifetime, seeded by the initial admitted route. Opening an entity or focusing a
pane keeps that section's rail and list. Explicit section navigation uses
`useOpenAppSection` (including catalog activation and phone main tabs); ordinary
destination routers and open Actions keep their existing entity-open meaning.
Reloading or admitting a different Account starts from that entry route again.
An edge open or drop uses the measured split owner even when the destination is
already open: it moves the existing tab beside the target pane rather than
silently activating it. Plugin app pages retain their single mounted instance.
Phones push the entity within the selected tab and do not offer splits.

An ordinary rail or collection-row open focuses the destination's existing tab,
or replaces the current tab's content when that destination is not already open.
Retained and preview tabs follow the same rule. Only an explicit Open in new tab,
modifier-click or split intent creates another tab; the existing unsaved-change
guard still controls departure from an editor. Explicit item instances survive restore and sync; singleton admission applies only to the existing app-page hubs. The portable tab schema is unchanged.

Contextual Start destinations use the Details arm of `PanePresentationIntent` with
`start: true`. `dispatchDetailsTabOpen` owns placement: the existing Details
renderer on wide screens, or that same scope's renderer in a large phone sheet.
Transcript hosts without pane columns declare `DetailsStartSheetHost`; they use
that same sheet inside their current host at every width. This covers tool-message
details, standalone Run details and navigable embedded Sessions. The sheet lends
the existing Session Details renderer for its mounted lifetime; no public
`session.open` destination or separate opinion modal is involved.
Cockpit page presenters decline Start; callers do not choose a phone route.
The focused Chat scene consumes `detailsStartScopeId` and leaves that sheet open
until dismissal instead of closing Details as part of its ordinary pane sync.
Replacing the Details tab replaces the sheet body too. Closing the sheet releases
its body and leaves saved desktop visibility under the existing persistence owner.

`ContextualStartComposer` owns Opinion and Run's Who, question and Where controls.
Each flow supplies its existing choices and declares what the composer may offer.
Opinion retains Discussion's Account, Bot, Session and model candidates, recipe
Change, and editable Machine and folder. Its Account directory search belongs to
that same Who list; a folded list exposes it through Show all. Run supplies its
canonical Agent/model options and keeps its Machine read-only. Session and comparison starts retain
their existing folder; other detached starts allow folder selection through
Workflow's path browser. The shared controls do not change Run admission or turn
participants into Runs. Accepted opinions replace Start with their Discussion
even when the answer also starts a Fresh opinions Run.

Run starts use `SessionInteractiveExecutionRunDraftView` and the Session draft
repository. Seeded review, plan and delegate requests enter through
`buildExecutionRunActionDraftInputForUi`; the retired transcript-card records are
imported once into the existing intent/role draft. The importer preserves an
existing selection, appends instructions, and removes each source only after the
destination is durable. Interrupted source removal can leave editable duplicate
instructions on retry. Running and unsupported historical records remain intact.
Comparison review uses the same Run form and `startReviewOfComparison` adapter;
the plugin review selector returns admitted credential choices from that form
without starting a review. Review options share `useReviewExecutionRunLaunchOptions`.
Connect uses its existing anchored presenter on wide screens and its body inline
on phones. Partial starts name the reviewers that did not start in the accepted
Run's result, while the existing group-findings owner keeps sibling findings
accessible. Comparison acceptance also retains the originating SCM pane's reviewer
links and requested walkthrough navigation. Accepted Run markers open the Run
through the Details command owner.

Contextual Workflow starts use the same Start placement. Session and Discussion
callers pass a definition reference to `WorkflowStartDetailsBody`; the mounted
body reads the selected definition and uses `useWorkflowComposerStart`. The
existing Account-scoped `useWorkflowRunNowController` retains reviewed inputs
and a pending submission across dismissal and reopen. Acceptance replaces the
Start tab with the existing Workflow Run pane. Saved Workflow selection stays
in the Session; All workflows remains explicit library navigation. Definition
listing retains its existing body-bearing pages; the picker adds no per-row
definition reads.

Short value-returning forms use `createAnchoredSheetChrome`: an anchored card
on wide screens and a bottom sheet on phones, with the existing no-anchor
placement when a trigger is unavailable. Plugin Action inputs, Session-address
selection, review selection and Session recipes keep their domain bodies and
cancel/retirement owners. A selector returns a value; it does not start work.
Library, editor and replay Workflow starts use this chrome around their existing
composer rather than the contextual Start pane.

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

Pane visibility is desktop layout state. At a phone landing, `AppPaneProvider` restores selections,
tabs and view state through `model/paneScopePersistence.ts`, with Right, Details and Bottom closed
and main visible. This also applies to late hydration. Explicit open actions still present phone
sheets. Phone-landing writes checkpoint content and selection while preserving saved desktop
visibility, including after resizing, so returning to a desktop landing restores the columns.
Resizing an already open view retains its current panes; it does not hydrate them again.

Session Editor-first pages keep their desktop selection in the same scope's optional
`mainTabId`; the right pane retains its independent destination and visibility.
Selecting or closing a companion leaves the main page selected. Returning to Chat clears
only `mainTabId`. Phone writes preserve this saved desktop choice. `SessionRightPanel`
supplies each visited body's stable keyed surface to `PaneColumnsHost`/`MultiPaneHost`,
which moves its presentation between main, side and hidden without remounting it.
If both selections name the same body, main presents it while the companion checkpoint
remains saved; hidden bodies retain their existing demand and unsaved-work lifecycle.

Project Open and standalone Source details publish page Back through
`components/ui/layout/usePageBackControl.tsx`, consumed by `PageHeader` via
`NavigationBackChromeProvider`. Open uses its existing cancel path with a
`/projects` fallback; Sources uses `safeRouterBack` with `/projects/sources`.
The Source loading and unavailable states retain the same header and control.
Split list/detail layouts keep the list as navigation instead of adding a
second detail Back. This is unreleased 0.3 behavior.

## Main column visibility

A host offers hide/show by supplying `mainColumn: { hideLabel, showLabel, identity }`.
The destination supplies its own name, mark and existing lifecycle presentation; the shell does
not infer a Session or Workflow state from a scope id. A host without this descriptor offers no
hide control. Session and Project headers supply their domain wording; app pages use their title.

`PaneScopeState.mainHidden` is persisted pane state, changed by the `setMainHidden` reducer
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

The device-local `rightPanelPlacement` setting (`separate` default, `line`, `shadow`; anchor
`appearance.rightPanelPlacement`, set from Appearance tiles and the Look panel, agents via `settings.get/set`)
chooses how a page's docked right panel stands against the page. Stored values from before the three-way
choice read as their successors (`canvas` → `separate`, `sheet` → `line`); unknown values read as `separate`.
`SidebarNavigator` reads it once; the frame resolves it (`line` without chrome and off the web) into a
placement (`canvas` for Separate, `sheet` for the joined styles) and a divider, and publishes the tail hosts
and the page's empty-tail width through `appShellTail.tsx`. On the web shell the page's action rail always
stands in the tail, on the canvas, like the app rail; with Separate the docked right column stands there too.
`PaneColumnsHost` uses the tail only for the one page on screen at the trailing edge (not Editor first, not one
pane of a split) and budgets its layout with the empty-tail width, so every placement resolves the same widths.
`AppShellTailSlot` keeps one container per column, so changing places moves it without remounting. Overlay,
in-main and hidden presentations and the details drawers stay in the page. With Separate the docked panel is
a sheet of its own: content paint, the page's corner radius, an 8 px canvas gap from the page and the window
inset beneath it, drawn inside the column's own width so it opens, closes and resizes with it. With Line or
Shadow the panel joins the page sheet, divided by a hairline or by the pane header's shade turned on its side
(`JoinedPanelShade` in `MultiPaneHost`), and the page casts its seam on both edges.

The rail's active action of an open docked panel is its tab (`PaneActionRailContext` `panelAttached`): the
panel's sheet, from the rail's inner edge, rounded away from the panel, with concave fillets. `MultiPaneHost`
gives every docked panel one opaque `surface.base` sheet (its `GlassSurface` is not glass when docked): the
panel stands in the shell's tail, nested in the page's coat in React but with nothing of it behind, so a nested
glass coat would be cleared over the bare window in the desktop app. The tab paints that same sheet. When it is the
first action it continues the top edge of the panel's sheet, which squares that corner (the panel's own, or
the page's through `AppShellTail.joinTrailingTopCorner`). Elsewhere the active action keeps its edge marker.

Every sheet's rounded corners leave pixels the sheet does not paint. `appShellMaterialPlane.tsx` owns the
shell's sheet geometry, the canvas coat (`useAppShellCanvasCoat`, the chrome plane the app rail stands on)
and `AppShellSheetCorners`, which coats those cutouts once with the neighbouring plane (masked to the outside
of the curve, never behind a translucent sheet), so the desktop app's native window material never shows at a
corner. Everything on the trailing canvas (trailing corner cutouts, the window inset, a Separate panel's gap
and inset, the rail) takes that one canvas coat; only the navigation column has the sidebar plane. The tail
paints no plane of its own and the rail paints nothing of its own: it lays the canvas coat around its tab
(left out under the tab and its fillets, and masked outside the tab's rounded trailing corners with
`AppShellSheetCorners`), so no pixel of the rail shows the desktop app's bare native material.

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
Session selection still opens Changes when available. A fresh Project scope starts with its pane closed at
every width, so the page has its room first; the rail opens a companion, and that choice then persists per
scope like any other pane state.

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

Session detail navigation resolves at `detailNavigationItems`: the existing sidebar registry delegates
to that owner, and desktop/phone chrome projects its admitted destinations. Chat is the default page;
Open files remains owned by the workspace strip on desktop. In desktop Editor-first, Session-group
tools expose both page and companion destinations: the Session column draws them as page tabs under its
header (`SessionPageTabs`), only when more than one page is eligible, and a selected page starts under that
header and strip (`PaneMainTopAnchor` reports the inset to `MultiPaneHost`). A desktop body resolves its own
list beside the phone navigator's; it reuses an enclosing list only when presentation (and on desktop,
arrangement) match. Review, Terminal and Computer retain their existing Details, dock and screen effects.
Customize is one `DetailNavigationCustomizer` per page kind with Desktop / Phone, each addressed list and,
on cockpit phones, the Bottom/Top page-tab choice; with Top, pinned pages scroll in `PhonePageStripView`
under the header (Session, Project, Discussion and Machine), and the bottom bar keeps companions and the single More.
With Chat as the only pinned page, Session and Discussion draw no phone strip and Chat keeps its bottom slot.
A desktop detail with Chat alone draws no strip. A phone consumes the mounted Session catalog and selection; its
pathname no longer independently chooses Session chrome. Project likewise publishes its mounted
catalog and restored selection to floating and native phone chrome. `projectPageCatalog` joins its
pages and admitted companions through `detailNavigationItems`; Changes and Code each have page and
companion destinations. Their phone buttons select the page, while desktop companion launchers retain
their pane selection and are suppressed only while the corresponding page is active. App tools remain
companions. Discussion's pane host resolves Chat as a page and Participants, Agents and Details as
companions through the same item owner. Its focused mounted presentation supplies phone chrome;
the route retains only the existing surface parameter. The desktop rail, phone panel adapter and
`shell.column` reads and selections consume that list without acquiring Discussion data.
Discussion desktop companions read `detailPages.discussion.desktop.companions`, with catalog defaults and no seed;
Project/App keep `workspaceRail`. Discussion phone items read `detailPages.discussion.phone.items` independently.
The shared phone placement/menu owner fits both floating bars with room for their permanent More/Customize trigger;
native presenters use the same item placement without a second overflow decision. Discussion rail and phone More
open the same Desktop/Phone customizer. Discussion's Chat-only Top mode keeps Chat in the bottom bar without a page strip,
while retaining the mounted thread. The existing Chat roster acquisition serves recipients, mentions and faces; opening Participants
reuses that owner and mounts only the selected companion.

In 0.3 development, Machine's typed tab table remains its body/route adapter and supplies page descriptors to
`detailNavigationItems`. Its desktop strip, phone strip/bar and mounted `shell.column` owner consume that list.
Machine page placement uses `detailPages.machine.desktop.pages` and `detailPages.machine.phone.items`, with
catalog defaults and no seed; `pageTabs.machine` changes only Cockpit phones. Classic keeps its in-page strip.
Overview remains pinned. Hidden placement does not deny a direct route. The mounted Machine publishes phone
chrome with its Home identity; no pathname fallback selects it. There are no declared Machine companions, so
the Machine side column is unavailable. More and Customize only describe navigation: the selected route still
owns plugin acquisition, core resource demand, tab retention and nested scroll ownership. Navigation does not
wake a stopped Machine. Service-detail content retains its existing Back and control Actions.

In 0.3 development, Workflow editor Steps/Flow and run Map/Steps/Activity descriptors come from
`detailNavigationItems`. `workflowNavigation` adapts their existing controlled view and pane owners;
`WorkflowNavigationViews` renders shared tabs, rail, phone More and Customize. Editor Flow can be
a page or an independent companion; Settings retains its inner Settings/Agent content.
Settings opens through the mounted editor's navigation Action on desktop and phone; the editor
binds that Action to its addressed Account lifetime or the active Profile Account
when no lifetime is supplied. An explicitly null lifetime keeps that Action unavailable.
Run inspection stays in `DetailsPaneHost`, with the same selected invocation and run consumer. Placement addresses are
`detailPages.workflowEditor` and `detailPages.workflowRun`: desktop `pages`/`companions`, phone `items`.
The corresponding `pageTabs` branch affects Cockpit phones; Classic retains its in-page strip. Only
the presented mounted body publishes phone chrome. The Workflows library remains a collection filter,
and Start remains a run operation rather than a navigation item. No draft or run state is copied.

In 0.3 development, Environment's canonical deployment navigation ids feed `detailNavigationItems`.
`environmentNavigation` adapts the existing route destination, including Settings-section links, to
the mounted main-column Action; it has no companion column. Desktop pages and phone items use
`detailPages.environment.desktop.pages` and `.phone.items`, without seeding from Project. Cockpit
honors `pageTabs.environment`; Classic retains the in-page strip. Only the presented Environment
publishes its child projection. The enclosing desktop pane and phone Project column registrations
delegate navigation to that model; the phone chrome presents the same model. The parent Project's
desktop tabs and phone top strip yield to the child's navigation while retaining Project identity.
Leaving or hiding it withdraws the projection and restores the parent Project presentation and column Actions.
The existing Variables draft owner retains the unfinished bulk file, classification choices and created
Saved Secret references across page changes; cancel and the editor's scope lifecycle clear them.
Deployment reads and lifecycle stay with their existing owners.
Receipt and provider details with one view do not gain an empty navigation strip.

The Project header and phone More menu open the shared Desktop/Phone navigation customizer.
Its desktop sections edit pages and companions independently; its phone section edits one item list.

`shell.column.get/set` address `navigation` (the default), `main` or `side`; `tab` selects a page on
main or a companion on side, through the mounted owner. Optional read `items` expose navigation
metadata without loading bodies. Main visibility uses the inverse
of `mainHidden`. Arrangement uses `settings.get/set` on its declared anchor. Widths remain continuous
geometry controls rather than Actions. These reversible view Actions retain their existing default
approval policy; per-Action user settings still apply. See [Actions](actions.md).

Resizable collection widths and presentation-host bindings are documented in
[Collection presentation](collection-presentation.md); installed-plugin ownership is described in
[Plugin platform](plugin-platform.md).
