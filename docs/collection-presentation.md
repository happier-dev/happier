# Collection presentation ownership

A Collection presents keyed items through one headless model, shared list/table/board/grid anatomy and responsive detail composition. The caller owns the data, route, actions and view preference. The presentation layer owns how those facts fit together.

This page describes **0.3 development source**. It promotes implemented owners, not the historical Collection plan's rollout or unverified fidelity claims.

## Model and presentation

In 0.3 development source, serializable membership uses Protocol's
`collections/filter/fieldRegistryV1.ts` and `entityListFilterV1.ts`. Session work
keeps its existing flat `SessionListFilterV1` record; Workflow definitions and
Discussions have their own typed records. Each field declares `list` and/or
`daemonRule` support. The registry compiles the selected conditions once for
held facts, with known miss taking precedence over unavailable, then match.
Compilation and matching own no loading, polling, plugin activation or Resource
demand. A stored unknown condition remains unavailable until its evaluator is
restored or the person explicitly removes it. Current writes use closed schemas.

The editor's `CollectionConditionBindings.evaluator` defaults to `list`; stored
Follow and matching-session routing editors bind `daemonRule`. Field support
comes from the registry in both editor choices and write admission. Branch,
Needs-you and plugin fields are list-only in the current Session registry;
sharing the editor does not make them executable by a source daemon. Existing
unsupported stored conditions remain visible as unavailable rather than being
discarded or treated as matches.

Plugin pages reach the same pure evaluator, typed field factory and held-value
adapter through `@happier-dev/plugin-ui/components` (`CollectionFilter`). Custom
fields use admitted scalar, set, boolean or time values, rather than executable
plugin predicates. Absolute Updated bounds have strict before/after and inclusive
between semantics; there is no relative-time refresh loop. This describes source
ownership, not release availability or completed host-header integration.

### Settings column adapters

Settings domain folders expose `*ColumnAdapter.ts` bindings (Team/Home administration
use plural `*ColumnAdapters.ts`). Their shared slot-only binding lives at
`apps/ui/sources/components/settings/shell/settingsCollectionAdapter.ts`.
Each accepts held, privacy-projected domain facts and produces the existing
`CollectionRowContent` identity, title, one context line and trailing slots.
Status rendering is explicitly icon-only; counts preserve unknown versus zero.
Child keys and expanded/collapsed rollup facts remain separate from row content,
so the existing collection model retains hierarchy, selection and navigation.

Each binding supplies a Protocol P6 field registry. Connected services uses
qualified Service/Status, Skills uses Source/Machine, and MCP uses Status/Runs on.
Missing facts and unknown conditions remain unavailable, including exclusions;
known empty sets miss positive selections. Source identities are not parsed from
labels, and Machine reach is supplied by the existing Reach projection. These
adapters do not load data, probe a Machine, acquire quota demand, persist filters
or introduce a second evaluator. Shared described-row density, condition-editor
rendering and page composition remain their public presentation owners' work;
the existence of an adapter is not whole-page fidelity or release evidence.

**One-press filters.** What people filter a list by most stands inline: `CollectionToolbar` `refine.chips` (plugin-ui `HappierCollectionFilterChips`) on a toolbar, and `useCollectionConditionHeader` / `useCollectionSpaceHeader` `quickFilters` on a column, drawn with the `SelectionListFilterChip` geometry. A chip is an existing condition value, toggled through `toggleCollectionConditionValue` and the entity's registry, so it adds no filter state; a grouped choice (a Work status) toggles its whole group. A chip that says a filter is on replaces that value's token. The long tail stays in the condition editor. Chips carry no counts: value counts stay demand-only while the editor is open. A single-choice field's chip replaces the value, so it never holds two. `useCollectionSpaceHeader` returns the row as `conditionRow`, apart from `strip`, because a control beside the strip must not narrow it. An on chip takes the selection fill and adds no glyph, so its neighbours stay put; on a toolbar the long tail holds the row's end, so chips that arrive with the data move nothing, and its count covers only what no chip says. Settings columns get a chip per status through `useSettingsColumnFilter`, unless a control on the page states status already or every row shares one; Workflows declares its `view` values.

The same public `CollectionFilter` surface exports `conditionModelFromFilter`
and `applyCollectionConditionEdit`. The pure model projects registry selections
into Field / operator / values rows and available fields, operators and values.
Optional presentation bindings supply localized field labels and held dynamic
value options; they cannot enable an unsupported evaluator. Row identifiers are
derived presentation identities, never persisted conditions. Add, change, remove
and explicit clear return the entity's typed filter through its registry's
selection owner and canonical value schemas. Include and exclude remain separate
`is` / `is_not` rows; unrelated edits retain opaque stored narrowing. Removing its
unavailable row or clearing all conditions is an explicit removal. This model
does not load options, match facts, render controls or change a storage format.

A value option may carry `values`, a grouped selection vector. Its `value` is
then only the presentation choice key; the generic picker applies the vector
through the same edit function and checks whether all its values are selected.
The Session Status fields provide Working / Needs you / Failed / Idle / Offline
groups from the canonical Work-filter owner, for both include and exclude.
Presentation bindings can label or disable these groups without redefining their
vectors. Existing partial raw-state selections remain raw selections; projecting
the editor does not expand them or persist a group key.

In the current development source, value options also accept `count?: number`.
This is a frequency in the list's already-held ordinary corpus, not a prediction
for unseen server pages or the result of adding that option to the other local
conditions. Include and exclude lists show the same occurrence frequency; grouped
choices count each entity once. `CollectionConditionBindings.valueCounts` binds
`{ fieldId, options: [{ value, count? }] }` by choice identity, without changing the
registry's selection vectors. Missing local evidence omits a count rather than
inventing zero or fetching facts.

The shared editor's optional `onValuePickerChange` reports
`{ fieldId, options: [{ value, values? }] }` only while that value list is open;
Back, dismissal and unmount release it with `null`. Merely opening Add filter,
rebinding labels or receiving counts does not renew demand. Sessions routes this
demand to its existing retained pane projection, which admits one count-fact
object per changed ordinary Session/Run while demanded, updates retained keyed
contributions, and preserves equal count-result references. Mirrors, attention
supplements and Run-step context are not extra subjects. Team/Group, tag and
subtree choices without held evaluable facts have no count. The editor neither
loads facts nor subscribes to rows; drawing the counts remains the presentation
consumer's responsibility.

The same compiled-option owner serves Workflows, Discussions and Settings-column
headers. `compileCollectionConditionValueCountOptions` isolates each choice
through its registry; `collectionConditionValueCountsFromFacts` takes a lazy
`readHeldFacts` callback and an optional previous count result. Closed demand and
unsupported fields never invoke the callback. Generic headers use their existing
pre-local-filter fact owners, not new queries; Discussion attention remains
unknown for held summaries without an already-joined attention fact. Changed
facts with equal counts reuse the prior result and unchanged option objects.

`useCollectionSavedViewsControl` in the same public components surface owns the
controlled picker and temporary naming presentation used by Triage. Its caller
supplies admitted display items, mutation callbacks, acceptance outcomes and a
stable captured-authority `scope`. Changing that scope retires a private naming
draft; a late accepted callback cannot change the next authority's presentation.
Triage retains its Account-KV saved views and Account-wide selected view; host
collection spaces keep definitions in Account `collectionSpacesV1` and selection
in this device's Account-scoped `collectionSpaceV1`. Sharing the picker does not
merge those persistence contracts. Space mutations use the existing settings
operation writer's typed `collection_space` intent and CAS rebase, preserving
unrelated winning edits.

Session/Run Status consumes the same P4 Work result as each row. Raw states stay
in their canonical Session or Workflow vocabulary; the registry does not convert
Run states into Session states. The incumbent grouped Work choices also apply
to Runs through that result's bucket/tone, while a partial raw-state selection
retains its exact meaning. Missing admitted status stays unavailable, including
negative conditions. Acknowledging a Run failure does not change its Failed
identity merely because its presentation becomes neutral.

[`useHappierCollection`](../packages/plugin-ui/src/presentation/collection/useCollection.ts), exported from `@happier-dev/plugin-ui/components`, composes grouping, order, filter, window completeness, focus, selection, expanded keys, route-controlled `openKey`, visit memory and drafts. Multiple selection reuses the existing [`multiSelection.ts`](../packages/plugin-ui/src/presentation/collection/multiSelection.ts) store/reducer. The model calls `onOpenChange`; it does not navigate or persist domain items.

Initial landing is optional: when the consumer supplies visit memory, items are ready and the measured mode is split, the model chooses the last visited available item, otherwise the first. Overview indexes may omit this policy. A draft uses a separate key and title store; it is not silently persisted as a real item.

The public `Tree.renderInlineEdit` slot replaces a row's display content with the caller's editor. The shared row suppresses activation and disclosure while editing, leaves nested controls' keyboard intents alone, and returns focus when an existing row's editor closes. The caller owns draft identity, submission, cancellation and errors. The shared `ArtifactFolderTree` uses this slot for both Artifacts and Prompt Library folders: Save/Enter submits through `artifact.folders.*`, refused writes keep the name and inline error, and Cancel/Escape discards the draft. Delete retains its confirmation. Draft names use the existing collection title store, so typing subscribes only the editing row; Account or folder identity changes retire the draft.

Folder Actions read through the shared Account-scoped Prompt Library catalog loader, which publishes readable destination authority before retained Settings/history maintenance settles. A stale reviewed revision is refused without replaying the mutation; the refreshed catalog supplies the revision for an explicit retry with the draft intact. Row CAS conflicts also refresh through the captured Account's publication owner, without borrowing a replacement Account's authority.

In 0.3 development source, the open prompt picker observes that same catalog and reads its folders and invocations through the Account organization port used by its library-list Action. Optional retained Settings/history cleanup does not hold the usable picker inventory in loading. Closing the picker releases its observation; Account retirement still withdraws its inventory and pending reads.

Controlled single choice is a separate capability: `Collection.selection.single` (also `List.selection.single`) supplies `value`, `onValueChange`, optional eligibility and an unavailable reason. It uses the existing row/card keyboard and physical-focus owner, exposes radio semantics, and changes the caller's choice without opening detail. Multiple selection remains the existing store capability; the two are mutually exclusive.

Transient option menus reuse the public [`HappierOptionRow`](../packages/plugin-ui/src/presentation/interaction/OptionRow.tsx) controlled anatomy through the app's `SelectableRow` adapter. Callers supply labels, accessories, disabled state, activation and semantic props; the adapter retains theme paint and keyboard/focus policy. Context's host-owned qualified document choices feed that same menu path for Account, Profile, Project and Session, while Instructions admits only PromptDocs. Neither the option anatomy nor its menu owns catalog admission, Home/Account currentness or mutations.

Page-scrolling loading placeholders use the bounded Collection viewport height, not the growing stage content height. The stage still supplies the available row/card width; adding skeletons must never increase the next loading inventory.

The public [`Collection`](../packages/plugin-ui/src/components/Collection.tsx) draws one `CollectionAnatomy` through the existing [`List`](../packages/plugin-ui/src/components/List.tsx) engine and card composition. `collectionTable.ts` owns [presentation and detail decisions](../packages/plugin-ui/src/presentation/collection/collectionTable.ts): table/list can split when their minima fit; board/grid use the host details pane when available and otherwise push the detail. A pane host's placement takes precedence over an in-page split; beside the open host pane a table recomposes into the two-line list (the same travel as the in-page split, the detail in the pane) and returns to the table when the pane closes. A resting table that could show nothing beside its title column (a phone) is the list as well, and there a title may wrap to a second line. Before measurement the composition does not claim a wide layout. While `loading` with no rows, table, list and board hold skeleton rows in their row geometry (grid: skeleton cards) and `empty` waits until loading ends.

Opening from the table keeps the opened row at its screen y, moved to the nearest scroll offset where the first row below the pinned group header is whole; closing restores the table the same way (`planHappierCollectionTransitionOffsets`, which knows header cells by `header: true`). The table's Entry cell may follow the title with a quiet `titleSuffix` (the item's designation, "#2481"), so Where names only the place. In the two-line list a row's second line leads with the anatomy's `byline` (where and who, "payments-api #2481 · Mara Okafor"), falling back to `where`; the table's Where column keeps `where`. `glyphBadge` pins a small corner mark to the list glyph (an icon or a live dot, its plate ringed in its tone, drawn and sized by the Collection); the table draws none because its Agent column says the same. A row's loud chip may lead with an icon (`Badge icon`). The list row's second line ends with `reason`, or, when the item has none, with the anatomy's `listFact`: the one trailing fact the caller picks for the list where the table spreads facts across its field columns (a task's agent asking, then an urgent due date, Blocked, then an agent at work). The table and cards never draw `listFact`.

A page-section list (a list scrolling with its page, `pageSections`) also draws each `listColumn` field as a fixed end column at its `minWidth`, centred on both lines, so figures line up down every sheet; the first sheet's bar (`pageSheet.header`) names the columns. A narrow stage (`isHappierPageRowNarrow`, a phone) draws none: `byline(item, { fieldColumns: false })` carries those facts, and a row-aligned `titleMeta` takes the end column back. A page row with nothing after it ends on the page row inset (`rowPaddingHorizontalPx`), the edge its sheet's sub-heading actions end on, and those sub-headings middle-ellipsize so a shared Source shrinks before the Environment that tells them apart.

An anatomy may supply a qualified page `destination` and shareable `subPath`, the same identity ordinary `openSurface` activation uses. The app presentation host adds workspace context menus, Cmd-click on Apple platforms / Ctrl-click elsewhere, Alt/middle-click kept tabs and href drag sources through its existing catalog/workspace owner; hosts without that presentation binding retain ordinary activation. These gestures request `mode: 'newTab'` (kept, non-preview); the separate fixed-strip pin is not changed. Collection rows merge these actions into the existing `List.Item` context, keyboard and overflow menu, retaining the row's own actions. Singleton destinations remain singletons. Core rows can decorate the shared item through `wrapItem` without forking its list/card anatomy or secondary controls.

All four presentations use the same search header, selection controls and `List.Item` row action/menu owner. The search field carries the narrowings in force as `tokens` inside its well (each a press target that removes exactly its narrowing) and, on web, shows its own focus key (`/`) as a key cap; footer key hints and that key cap share one `CollectionKeyCap`. Board column Lists do not replace the Collection's full selection inventory with their own mounted rows. Independent card actions remain separate targets: pressing Pin or an anatomy action never opens the item.

Row actions retain the shared item's destructive semantics and pending `busy` state. A table reserves the actions' cell at each row's end and a precise pointer reveals it on hover, focus, selection or an open row, so nothing shifts. A resting list (a phone, a narrow page) and every touch row keep that cell out of the flow: the row runs to the page's margin, touch opens the actions by long press (the row's context menu), a precise pointer sees the trigger over the row's end while hovering, and focus or an open menu reveals it; the trigger stays mounted and announced. Transient menus use the public `HAPPIER_MENU_ROW_METRICS`, independently of collection density; the app aliases those same metrics rather than defining another menu scale. An `accessoryWraps` row lets its accessory move below the primary text in the existing measured narrow layout, including grid-backed list rows, so a status does not squeeze the phone title. In the 0.3 development source, a page row with `fieldAccessory` uses the public List's fit resolver and row-field context: a field select stays content-sized beside its label in a narrow desktop column when it fits, and spans the row beneath its label on phones. The app Item and dropdown trigger consume those shared owners rather than an app-private field-width context or viewport decision. Below-row operations with a fixed page leading slot align with the row's text; auto-fit identity marks retain their existing outside-accessory anatomy rather than assuming a fixed width. Built-in Workflow actions share one leading-aligned measured column and align below the title on phones. Mutation acknowledgement and result feedback remain domain-owned. A host whose list fills a dialog (the Add skill, Add server and Add agent catalogs) provides `HappierCollectionRestingRowsContext` as `ruled`: its resting list then keeps the row hairline and one inset at both ends (where a row action ends), shared by text, a status at the title's end, the action and the loading rows, so the list reads the same at rest and while loading and stays ruled beside the open detail. The default (`air`) is unchanged for pages and phones. A host page that owns the open item in its route (a phone's Sources page pushes `?source=` and the header's Back resolves it to the list) provides `HappierCollectionNavigationBackClosesDetailContext` as `true`, so the pushed detail draws no Back beside the navigation's own; a plugin page gets the same through its page chrome.

Collection supplies the one visible/eligible row inventory for both model-owned and author-supplied multiple-selection stores. `isItemSelectable` excludes present rows; `retainedSelectionKeys` preserves only keys absent from the current sections and never overrides that exclusion. The headless model owns the store, not a competing all-items eligibility feed.

Idle table Space peeks when that row offers a peek, including when the optional multiple-selection capability is mounted. `x`, modifier gestures and the row menu enter selection; while selection is active, Space selects. Plain multi-select Lists and non-peek presentations retain their selection keys. Modified range-extension keys follow the store's visible eligible order. Ordinary arrows retain the presentation's spatial geometry, including the positions occupied by inactive primary items.

Peek and Move use the Collection's single roving row stop. Their controls retain their accessible names and pointer/touch behavior while staying outside the Tab sequence. Space reaches Peek; `Alt+M` starts the row's staged Move. `Shift+F10` or the Context Menu key opens the same row menu with those operations. The shared `List.Item` keyboard/menu owner consumes the enclosing drag adapter's existing staged operation, so movement, commit and cancellation stay with the drag runtime.

Multi-selection uses the shared store's anchor and focus: Shift-click selects a range, `x` toggles the focused row, Shift+Up/Down extends, and Escape clears. Command-click remains navigation even during selection. Session row menus retain Select; touch long-press still opens that menu, not selection. Once selection starts, ordinary row presses toggle and existing selection controls/action bars remain responsible for Done and bulk actions. Checkboxes are selection-mode-only, never a hover affordance.

The Collection model owns one logical focus key and spatial keyboard navigation across its presentations. Board has one primary-item tab stop across columns; left/right moves between columns and up/down within a column. List and Grid bind/reveal physical targets without independently choosing the Collection's cursor. Per-view scroll offsets and focused-item anchors, Board column anchors/vertical offsets, the horizontal Board offset and phone pager position belong to the same model. Re-entering a view restores its viewport once; refreshing data does not scroll it again. These are mount-lifetime facts, not cross-restart persistence. A host that replaces `renderPageScroller` remains responsible for its own page-scroller lifecycle; the current app uses the shared fallback scroller.

After a domain mutation removes the focused item, `selection.focusRequest` can request an available keyed row through that same physical-focus owner. When no row remains, the caller restores focus to its own result or recovery control; the Collection does not invent a mutation receipt or choose a new domain destination.

A grid card may draw the item itself in a `preview` band above its title (the anatomy's `preview` slot, grid only, pure, no requests); every card in the grid then reserves the band so rows stay equal. Such a card drops its identity row: `previewItem` frame anatomy sets the mark beside the title, `where` under it, and `reason` then `age` at the foot. The Artifacts browser uses it for documents' first lines and code. Its Work Board preview shows saved layout mode, source names, widget count, order, widths and Canvas positions through the shared `HappierArtifactPreviewCard`; the [Board Artifact owner](../packages/protocol/src/boards/workBoardArtifactV1.ts) builds the header projection from the saved Board body. Workflow steps and Board widgets mount only the prefix intersecting the measured preview band, using actual wrapped and scaled row heights; this does not truncate the saved structure, full summary counts or detail view. Generic writes and restores rebuild that projection. The preview neither resolves live work membership nor executes widgets.

Artifacts rows bind Open, Share, History and Delete through `useRowActions`, sharing their operation owner with the document pane and page. Open retains each kind's destination; sharing and deletion retain manage access and kind policy, while a shared editor can restore History without managing shares. Delete confirms before the revision-qualified `artifact.delete` Action. A policy-required approval opens the existing approval detail instead of reporting deletion; the Action's captured Account owner publishes the acknowledged mutation.

In 0.3 development source, the Artifact browser drains structural pages through `listArtifactHeadersV1` before publishing its complete header catalog; the transport's per-request page boundary is not a retained-catalog cap. Approval and Launch Profile detail reads run independently after that publication. Cold-row Share eligibility uses the canonical kind policy and explicit owner/admin access, while the sharing Action still admits actual opened content. History's Account/Artifact data lifetime does not depend on the responsive breakpoint: resize keeps selection and data, refresh failures keep the last-known preview, and successful Restore consumes the Account owner's acknowledgement. Body hydration and grant-only changes do not reread the server's storage meter; revisions, mode changes, additions and deletions do.

An opened session transcript also demands missing bodies for its linked approval headers, including settled requests whose body declares a receipt. This uses the same Account-scoped batch reader as background approval hydration; settled history for unopened sessions is not eagerly hydrated. Cross-device linkage uses the approval's portable Home identity and the canonical local profile resolver, while the strict body/header reader still decides whether a request may render. The Artifact store rejects older known header/body revisions, so a delayed read cannot replace a newer socket settlement.

Use the actual `presentation` and `detail: 'auto' | 'none'` API; do not copy old plan examples that propose `views`, a generic `drawer` mode or `detail: 'peek'`. Expanding a row uses the disclosure/peek owner. Switching presentation can remount cells; keep the model, route and required detail continuity stable rather than promising universal row persistence.

In 0.3 development source, the public grid's existing `CollectionCards` renderer
derives compact tiles from its row's anatomy: no description, preview or footer
content means one mark/title/`where` row. Missing descriptions are `null`, not
empty strings. Each grid row shares its tallest card's geometry; a one-column
described card follows its content instead of reserving two description lines.
Plugins receive this through public `Collection`, without importing its internal
card renderer or setting a separate compact mode.

In 0.3 development source, the model nests rows when its input supplies `parentKey` (a parent in the same group; a missing, foreign-group or cyclic parent makes a root). `deriveHappierCollectionTree` flattens each group depth-first with siblings in the caller's order and publishes `model.tree` (depth, sibling position, child count). Opening a parent is `model.openBranches` / `actions.setBranchOpen`, separate from the peek's `expanded` set; `initialOpenBranches` seeds it at mount. A filter keeps a match's ancestors as context and holds open the parents it narrows inside, but never adds a matching parent's other children. The table draws open branches as a treegrid (`aria-level`, `aria-expanded`, sibling position), indented one disclosure box per level; the disclosure is a pointer target inside the row, and Right/Left open, enter, leave and close through `treeInteraction`. The list composition (phone, narrow, beside a detail) draws owners only. A field may be `sortable`: with `Collection.sort` its title is a button with `aria-sort` and an arrow on the active key, and pressing it calls `onChange(key)`; the caller re-sorts. `Collection.summaryRows` draws non-interactive totals after the last group, each cell under its field column (in the list: the title and the highest-priority value).

Artifact History uses the existing modal chrome as a viewport-filling opaque page on phones and a bounded card on wider screens. The same mounted revision owner keeps its read, selection, preview, Restore/approval and close/focus lifecycle. Its measured body width and the canonical text scale determine whether versions sit beside the preview or the preview replaces the list; returning to Versions does not reread revisions.

`detailHeader(key)` supplies the selected item's title, optional subtitle and actions to the host details band, plus an optional `leading` identity mark beside the title and a `subtitleLeading` mark before the subtitle (both drawn without a tile; the host maps them onto `PaneHeader`'s `leading` and line leading, and the pushed fallback onto `PageHeader`'s leading mark and meta line). The host owns Close. `renderDetail(key, { headerHosted })` renders the same detail body in each container; when the header is hosted, omit the body's duplicate title and close controls. Where the detail is the page (pushed: a phone, or side panes off) the Collection hides its own header (the toolbar) and leads the detail with the one way back plus, given `detailHeader`, the same hosted title band (`headerHosted: true`); without `detailHeader` the band is the back control alone and the body keeps its own heading. In an in-page split the caller keeps its inline header. Given `detailHeader`, the Collection (through `DetailsPane`'s body) also owns the detail body's edge in the details pane, pushed and in the split: plain content stands on the title's edge (the sheet inset), while sheets, page states and a `PageHeader` inside keep their own edges, and `DetailsPaneFooter` still spans the detail. A `DetailsPane` with a `title` does the same; without a title, or a Collection without `detailHeader` (core pages that pad their own detail), the detail draws its own edge.

Opening or replacing an item binds the public opaque focus target to the detail's first semantic `Heading` / `PageHeader`, or to the shared app `PaneHeader` when `detailHeader` is hosted. The existing presentation-host focus adapter performs the transfer and native accessibility announcement; no DOM traversal or second announcement service is involved. A data refresh does not re-request heading focus. Closing returns focus to the item's row/card through the model's physical-focus request.

In 0.3 development source, Collection and standalone `DetailsPane` choose the app pane or in-page placement when the detail opens and retain it until close. A viewport change does not move the detail between React parents or retire its local action/draft owners. The app pane already fills the viewport when side panes cannot fit; its current geometry still projects `pushed: true` and the existing phone footer. The in-page detail keeps its responsive composition. Closing and reopening chooses the current placement. Replacing the host binding still retires the old placement. A caller-owned input chooser must also receive that caller's cancellation signal, so retiring its owner withdraws the host presentation before an abandoned confirmation can be accepted.

For a contributed glyph badge, return `{ mark: (pixelSize) => …, tone? }`.
Collection supplies the compact mark size and retains plate/tone ownership.
Public `BrandMark.pixelSize` fits an exact package logo into that slot through
the same shared renderer as host chrome; an adjacent accessible label can make
the mark decorative with `externallyLabelled`.

Toolbar and first-load placement (0.3 development): `header` may be a render that receives
`CollectionHeaderSlots` so a page composes one header row: `title` (the Collection's `title` prop drawn as the
row's heading, for a Collection that is the page; `null` where the host's navigation already shows the page
title, a phone's header), `search` (the field with its tokens at the toolbar's bounded width), `selection` (the touch-sized Select / Done selecting control, `null` when nothing can be selected)
and `pageActions` (what the host keeps beside the page title, such as the machine the page runs on; placed in the
row, the host draws no separate band for it; while the plugin surface is an offline read-only snapshot the host
takes these actions back into its own bar, so choosing another machine stays usable). Whatever the render receives, the list pane no longer draws; without
a render the search and the selection control share one row in the pane. A table that scrolls with its page is a
sheet with an edge; a Collection that is the page's body lies flat under the page header. An empty table cell
reads "—". A dense group band ends with its one trailing fact: its action when it has one, otherwise what its rows
share. `Collection.collapsedGroups` (caller-owned keys) draws a list or table group as its band alone: title, the
count of the rows it holds and what they share, rows neither drawn nor focusable; the caller opens it, usually from
the group's `groupAction` (the Tasks page's "Done 6 · This week · Show"). While the first window loads a table
keeps its column titles and enclosure and its skeleton rows fill the rows region from the top; in every
presentation the `empty` slot fills the rows region under the search header (`List` yields an empty scroller's
region to the slot).

In 0.3 development source, `Collection.sort.orders` optionally supplies named orders as `{ key, label }`.
The resting table's title column then is a quiet text trigger (the column's own title naming the active
order, with a `Popover.triggerDisclosure` caret, never a button face in the header row) opening the shared radio menu, which checks the entry matching
`sort.key`, and publishes `aria-sort` for an active named order (or `none` while a field is active).
Choosing an order calls the same `sort.onChange(key)` as a sortable field; the caller remains the only
ordering owner. The control remains reachable in an empty table; list and board do not draw this menu. `useHappierCollectionLayout()?.composition`
reports the rendered composition so header controls can retain a toolbar Order in those presentations
without duplicating it in the table. Triage uses its existing lens edit and mounted `setLens.order` path.

## Layout and host bindings

In 0.3 development source, a page sheet (`HappierPageSheet`) is the host's in-flow card: the palette's `sheet` fill is the card fill, and its optional `sheetEdge` carries the card's lip and grounding (W3 on light; Happier core resolves it once in `resolveThemeCardEdge`, and a host without it draws the flat hairline). Core `ItemGroup` page sections draw the same palette with no core-only override. Row hairlines use `rowDivider` and run from the row's text edge to the sheet's trailing edge (`happierPageRowDividerInset`, logical start/end), in core rows and public list rows alike. A section that indexes entities lies flat (`surface="none"`): no card fill, finish, lip or grounding, with the same text-inset hairlines.

In 0.3 development source, a page-scrolling List Collection owns its sheet inset. Standalone palette-backed page Tables use that same stage inset, including when they recompose as a narrow List. A Table already inside `HappierPageSheet` consumes that sheet's edge rather than adding another inset. Section headings and row-leading marks share the page's optical text edge. A custom page scroller constrains the column but does not add a second inset around the Collection body; Grid, Board and pane-owned scrolling retain their own anatomy.

A populated resting Table owns its themed enclosure on the existing stage. Measured narrow-screen and beside-detail compositions return to the List without another wrapper or a second row/focus owner. The Artifacts browser's List choice consumes this responsive Table; its columns label the actual Name, Kind, Source and Edited facts. On a populated phone library, the existing count follows the search and view controls rather than repeating an introduction above them.

`CollectionVirtualizer`, exported by the public Plugin UI root, components and presentation entry points, is the optional platform-windowing seam. `List.virtualizer` selects it for a virtualized List; `Collection.virtualizer` supplies the same adapter to its row and card Lists. A host may instead bind `collectionVirtualizer` through its presentation environment. An explicit List adapter takes precedence over the Collection adapter, then the host binding; omission keeps the incumbent RN/RNW FlatList/SectionList fallback.

The adapter receives the already-filtered flat or sectioned window, stable item keys, semantic row/header renderers, accessibility and layout facts, and scroll/content-size callbacks. It publishes a positioning-only handle after mount and withdraws it on unmount: reveal a row, scroll to an offset, or scroll to the end. It does not choose logical focus, change selection or own viewport memory, and exposes no native/DOM ref. List retains pending physical focus until the revealed row mounts. Host-specific virtualizer dependencies remain with their importing host.

In unreleased 0.3 development, custom tree adapters using [`useHappierTreeInteraction`](../packages/plugin-ui/src/presentation/navigation/treeInteraction.ts) forward row focus through `onFocusChange(key, true)` and blur through `onFocusChange(key, false)`; [`HappierTreeRow`](../packages/plugin-ui/src/presentation/navigation/TreeRow.tsx) supplies `onFocus` and `onBlur` for that binding. The logical roving tab stop survives focus moving to an editor, but a ref rebind repairs physical focus only while the tree row still owns it. The public `Tree` component wires these events itself.

`scroll="page"` keeps every row mounted in the page's scroller. `scroll="page-virtualized"` windows table rows, including their responsive list composition, against the containing page's existing scroll-activity tracker, with spacers preserving their full extent. Collection supplies its current row/header geometry; mounted-cell measurements account for wrapped content. The page tracker positions the same physical scroller, and List retains the single roving tab stop and pending focus request. On web, recomposition reveals the still-focused row without moving selection or pulling focus back from an outside control. No nested scroller or catalog truncation is introduced. Other presentations, or a table without a positioned containing page, use the incumbent virtualized collection scroller. The managed size comparison consumes this mode inside `ItemList`.

Board callers can select `boardLayout="stacked"` for domain-approved phone sections or `"columns"` for status columns; omission retains the shared responsive column pager. Columns keep the same text-scaled card-width track whether empty or populated, scrolling horizontally when they cannot fit, with a gutter at both ends. Grouping may retain empty axis positions (`retainEmpty`) on wide status boards; they show one quiet empty line without resizing neighbouring tracks on arrival. Counts sit beside their titles, with no column dividers. A non-empty group may use the shared Work semantic tone for its header; empty groups stay neutral. The shared List primary gridcell stretches card bodies to their column inset; stacked phone headers and cards share the page edge. Card collections with `detail="none"` omit the pane keyboard-hint bar. The model still owns cross-column arrows, one primary tab stop and viewport memory. `CollectionAnatomy.boardContent` supplies a domain card body inside that same physical interaction owner, not another press target or cursor. `CollectionAnatomy.cardContent` does the same for `grid`: a live domain body (it may subscribe; `preview` stays pure) drawn edge to edge inside the card's one press/focus target in place of the generic head and description, while `reason` and `action` keep the footer's slots and the action keeps its own target. The body declares its height at normal text size (`{ height, render }`); the grid scales it with text size and keeps every card that height, so a card never grows with its content. The Work Board keeps the model mounted when switching Canvas/By status, without rendering hidden cards, and requests its focused card again when the item route returns.

[`HappierListDetailLayout`](../packages/plugin-ui/src/presentation/collection/ListDetailLayout.tsx) owns split geometry and publishes the measured mode through [`collectionLayout.tsx`](../packages/plugin-ui/src/presentation/collection/collectionLayout.tsx). Consumers read `useHappierCollectionLayout` or `useHappierCollectionIndexView`; they do not mirror layout mode into another state/context.

The app's [`SettingsCollectionLayout`](../apps/ui/sources/components/settings/shell/SettingsCollectionLayout.tsx) binds that geometry to the nested route stack and keeps its detail stack mounted across wide/narrow composition. It is an adapter over the shared owner, not another split engine. Host motion comes through the Plugin UI presentation host; plugins do not acquire Reanimated or app-internal navigation dependencies to reproduce it.

In 0.3 development source, Connected-services names use the qualified descriptor's
localized title, then a readable retained service identity; colliding titles carry
the actual plugin identity. A name never establishes installation or execution
availability. Skills use [`skillSource.ts`](../apps/ui/sources/components/settings/skills/skillSource.ts)
for the same source fact across collection and detail. Its registry names come
from held Account catalog and applied plugin metadata, indexed by source id or
exact source URL. Missing metadata keeps the repository/host fallback, rather
than inventing a source name. The parent supplies each row's name; this binding
subscribes to existing facts without starting a catalog/registry or Machine read.

A settings collection's rail takes its width from a role, never a page-local number: `SettingsCollectionLayout` reads `railWidth: 'standard' | 'detailed'` from `HAPPIER_COLLECTION_RAIL_WIDTH_PX` in [`pageMetrics.ts`](../packages/plugin-ui/src/presentation/layout/pageMetrics.ts) (`standard` for one-line rows, `detailed` for rows that carry a description or facts line). The role is host-internal: no plugin draws a settings collection's rail. Every settings collection takes a role; no page keeps a number.

In unreleased 0.3 development, that role supplies the default rather than a fixed width.
`HappierListDetailLayout`, public `ListDetailLayout` and `Collection` accept controlled
`listWidthPx` with change, commit and reset callbacks. The shared split geometry clamps rendered
width between the row-derived list minimum and the remaining detail budget; resizing does not
change the Collection's presentation target. Rails use Plugin UI's shared resize handle, reset to
their owner default on double-click, and never collapse when dragged below minimum.
These width props govern the layout's own list/detail split. When a Collection opens detail in
the host pane, that pane retains its existing width and placement authority and uses the shared
host-pane handle; a collection resize key does not override host geometry.
The app's `useCollectionRailWidth` stores widths in device-local `collectionRailWidthsV1`, keyed
by the collection's stable resize key. Plugin-authored layouts can supply `resizeKey`; the optional
presentation-host `panelSizing` binding namespaces it with the plugin id and uses the same record.
Without that binding the component retains the width only for its mounted lifetime. See
[App shell panes](app-shell-panes.md) for the shared geometry and visibility owners.

A collection with something to say beyond its list has an Overview at its root route, beside the rail and on phones; one with nothing to add lands on its last visited or first item, with no Overview row (Roles). The rail's first row is the index row, [`CollectionIndexRow`](../apps/ui/sources/components/ui/lists/collection/CollectionIndexRow.tsx), named Overview in every collection and selected at the root. An Overview never lists the rail's rows: it keeps what needs the person with its fix, what only the page can draw (the MCP and Skills maps, the Machines comparison), and what could be added. `SettingsCollectionLayout` draws no header above its panes; a collection's identity is the rail's title and the detail's own header.

### Machines page doors (0.3 development)

The Machines page has two doors over the same components. Settings → Machines (`/settings/machines/**`) is a `SettingsCollectionLayout` with the machine list (`MachineCollectionRail`) as its rail, beside the Settings column. The rail door (`/machines/**`) is the shell destination `machines` in [`compactAppDestinationCatalog.ts`](../apps/ui/sources/components/appShell/destinations/compactAppDestinationCatalog.ts): its built-in `machines` column ([`MachinesColumn`](../apps/ui/sources/components/machines/collection/MachinesColumn.tsx)) hosts the same list where the Settings column would stand, so "Hide column" and column sizing stay with the shell owner. The destination is marked `railControl: 'footer'` because the rail's footer Machines icon (its popover) already draws it: the rail, its customizer and the phone launcher skip it, while it remains a visible destination for location (the Machines rail item is selected on `/machines/**`) and for the command palette's "Machines" command.

Each door sets `MachinesDoorProvider` ([`machinesDoor.tsx`](../apps/ui/sources/components/machines/page/machinesDoor.tsx)); rail-door route entries set it themselves so a workspace-hosted body and the Expo route resolve the same door. Every machine-page link is built by `machinePageHref` in [`machineCollectionModel.ts`](../apps/ui/sources/components/settings/machines/collection/machineCollectionModel.ts) for the current door. Surfaces outside Settings (Boards, System status, session info, runs, New Session, managed creation, Git installables, Home) link through the rail door; configuration pages (add, defaults, this computer, pools, recipes) exist only in the Settings door. All machines' List | Grid choice is the declared device-local setting `machines.indexView` (`machinesIndexViewV1`), changed by the page control or `settings.set`. Each machine's resource summary — the popover rows, the list column, All machines' metric cells and card tiles, and the New Session picker's memory fact — is drawn only by [`MachineSummaryStrip`](../apps/ui/sources/components/machines/summary/MachineSummaryStrip.tsx) over plan 20's summary hooks (values, tone and lines are never re-derived in UI), through the shared chart, meter and ring owners; a structural test keeps drawing libraries out of `components/machines/**`. Its style and shown metrics are the device-local Appearance settings `appearance.machineSummaryStyle` and `appearance.machineSummaryMetrics` (an empty list is kept: names only). Every open surface mounts one batched `useMachineResourceLiveDemand`; rows subscribe per machine.

In 0.3 development, opening the Machines popover and observing recovery update
the existing keyed device UI-state projection, scoped to the exact Account and
Home. These observations do not publish Settings changes. The old
`machinesRailSeenV1` setting is copied out before removal. Its record lacks an
Account identity, so its retained unscoped cursor cannot acknowledge any scoped
fleet; each Account/Home begins unseen until this device opens its popover.

## Sessions and Workflow Runs

In unreleased 0.3 development source, Protocol's
[`Session awareness presenter`](../packages/protocol/src/sessions/awareness/presentationV1.ts)
owns the Session display state. The existing Work adapter consumes that answer
and C1's admitted attention type independently. An unseen primary failure can
therefore remain rose while a concurrent approval still has its own review
control. Failure updates and mentions do not become Inbox Needs-you; manager-handled
and non-blocking requests retain C1's quiet treatment. Stopped requires an
observed process-terminal fact, and usage-limited requires the current typed
blocking issue rather than a recovery countdown or a successful control acknowledgement.

Session failure acknowledgement reuses the private read cursor. The server's
[`personal projection`](../apps/server/sources/app/session/personal/projection.ts)
batch reads the exact current failed turn's committed transcript end anchor and
publishes nullable `viewer.latestFailureSeq`; the personal attention owner compares
that fixed sequence with `lastViewedSessionSeq`. Missing evidence is not a new
failure. Later unrelated messages do not restamp it, and opening a request peek
does not advance the cursor. The CLI's native, prompt-failure and strict-resume
terminal paths share the failure-marker receipt owner. This describes current
source ownership, not completed loaded-runtime or provider certification.

The same public `HappierWorkStatusPresentation` family carries domain `state`,
existing bucket/tone/word, C1 `attentionType` (nullable when not admitted), and an
optional public icon token. Plugin UI renders those supplied facts; it does not
classify Session lifecycle or Inbox admission. The strict Session surface transport
accepts that same shape. Server-produced coordinator summaries provide actual
`finished` and strongest `attentionPrimary` alongside their existing counts;
filtered or collapsed child rows never supply a fabricated completion denominator.

Workflow Runs use their current failure's `finishedAt` identity and the nullable
`AutomationRun.attentionSeenFailureAt` marker, not the operational Run revision.
Only the owner Account receives that failure notice and may acknowledge the exact
observed failure through `workflow.run.read_state.set`. Team/Artifact viewers keep
the Failed history but neither receive this private notice nor write the marker.
Custody and attention revision changes cannot revive an acknowledged occurrence;
independent invocation review remains actionable. Request peeks explicitly disable
failure acknowledgement. See [Actions](actions.md) for the write contract. The new
column still requires the target database's canonical migration deployment before
loaded-runtime verification; source implementation is not a deployment claim.

In 0.3 development source, Work Board column lines and pinned counts read membership and status summaries, not card titles or bodies. Active Board detail reads only its member kinds and retains its last-known cards while unfocused; returning to it projects current facts. Workflow summary consumers share one Account-lifetime request owner. The Board Artifact projection joins exact in-flight body reads and publishes readable neighbors independently; invalidating one Board does not reread every demanded body. Needs-you demand mounts the canonical Inbox producer without changing the Board descendants' topology.

The Boards index renders names from Artifact headers before Board bodies settle; live summary lines fill in independently. Header readiness and each Board body's loading/error state belong to the same Account store. A Session card retains its last settled facts during a re-read, until its source supplies a new result. The open Add picker exposes loading for Sessions, Workflows, Runs and Machines independently through their existing read lifecycles. Board deletion carries its exact-Action confirmation to shared approval policy and leaves the detail only after acknowledgement; a refusal remains recoverable through the Board save owner.

In 0.3 development source, [`SessionsList`](../apps/ui/sources/components/sessions/shell/SessionsList.tsx) owns the mixed Sessions/Workflow Runs list, including the Workflows column's Runs view and `/workflows/runs`. `SessionListFilterV1` owns Show and Started by; the same Run predicate serves Board filter membership. The existing Account-scoped Workflow read windows supply Runs, and the existing parent-work nesting owner attaches step Sessions beneath their Run instead of presenting them as independent roots.

Session Project identity comes from Protocol's
[`accepted-association resolver`](../packages/protocol/src/workspaces/workspaceRefResolutionV1.ts).
An admitted row's opaque `projectKey` is qualified by its Home and does not wait
for private checkout or display data. Keyless rows keep their exact Machine/folder
group while the opened census is unavailable, rather than entering a pending
Project bucket. The existing Project snapshot supplies private display facts;
grouping adds no repository discovery or per-row read. Private checkout inference
requires the opened Home and viewer Account plus genuine Session owner authority;
readable recipient rows do not borrow the viewer's private census. Released rows
without an immutable owner id may use the canonical legacy owner projection, not
missing access fields or a display owner. Published Project keys remain usable
independently of those private facts.

Saved ordinary sibling positions and scopes survive page/filter omissions;
the loaded window is not deletion evidence. Syntax normalization and the existing
pinned-membership rule remain separate. Keyless checkout order uses the retained
opaque FNV encoding rather than publishing raw paths; that predecessor-compatible
encoding is not collision-free and does not change exact in-memory checkout identity.

The shared [`Project display owner`](../apps/ui/sources/sync/domains/workspaces/projectGroupDisplay.ts)
selects the baseline by accepted-ref creation time and qualified id, never by
reachability, activity or visible row order. Project title overrides belong to
the Project organization row. Header Rename/Reset uses the revision-qualified
`projects.organization.update` Action, preserving the other organization fields;
it does not rename that baseline checkout.

Display does not depend on a Project header remaining visible. Accepted rows read
that same Home-qualified display index in Sections, Pinned and Recent. A keyless
row carries its already-admitted exact-group name (for example, Home folder) from
the base list projection through filing and Recent; this transient display fact
does not create a Project association or consult private checkout data. The shared
display reader supplies both row context and single/bulk Move menus. A published
Project key takes precedence even while its private display remains unavailable.

The nonvisual Session row-context owner consumes that selected baseline rather
than electing another. It compares admitted Machine and checkout ids, not labels
or matching-looking paths; unknown checkout identity is not a default checkout.
A displayed parent may establish the same Home/Machine/checkout context, but
cannot hide a different Project or Machine. Disabling optional visual context
retains the original Project/Machine/branch facts for accessible row identity.
The canonical nesting projection supplies those admitted parent ids on the
transient list item, so bulk and deferred mounted rows use the same authority.
Parent metadata loss, detachment and flat attention mirrors do not inherit stale
Machine/checkout facts; the child's execution workspace remains unchanged.

The existing favicon resolver shares results and pending work by exact scoped
Machine/path. Its hook accepts a fixed source and admitted reachability: an
offline source has a stable fallback and makes no request, while an actual
source change or reconnect can refresh through that same result owner. Initial
copies reuse the cache. `useWorkspaceFavicon({ demand: false, ...source })`
passively observes that same resource and stable result reference without
resolving or retaining pending work; its default `demand: true` owns the read.
`SessionListRowContextPresentation.projectFaviconSource` supplies the row
Project's accepted baseline as `{serverId,machineId,workspacePath}` or `null`,
including flat attention occurrences. It never substitutes the row's execution
checkout or its display group's Project; optional context visibility does not
retire this authored identity source.
The list renderer must choose one demand per visible Project source (the header
when present, otherwise a visible base/promoted Project mark), with other
base/Needs-you/Working marks passive; that row binding remains integration work.
Passive-only marks do not load a source.
A new source cannot briefly display the old source's icon, and retiring the
last demanding reader cancels its pending request. This adds no
candidate probing, timed negative cache or polling.

In 0.3 development source, Session checkout context carries a **last-observed**
branch, not guaranteed-fresh Git state. Checkout preparation retains the actual
realized `branchName`, never substitutes the requested `baseRef`, and the birth
adapter maps it into private `SessionOwnerWorkspaceV1.branch`: a string names the
observed branch, `null` proves detached/no branch, and absence means unavailable.
The existing Account-mode owner envelope and authorized compact/warm-cache
projections retain that distinction; branch text is not a server-visible row
column. An already-demanded Session snapshot in
[`ScmRepositoryService`](../apps/ui/sources/scm/scmRepositoryService.ts) may update
it through the existing Account-scoped metadata writer after a real change,
with owner, Home and exact checkout revalidation. Equal or unavailable
observations do not enter the writer. A changed observation uses the writer's
ordinary mutation read; this adds no SCM probe, watcher or polling, and makes no
loaded-runtime verification claim.

The development Session list separates an entity from its displayed occurrences. A Session has a base occurrence and may have one flat Needs-you or Working shortcut. The canonical index identity owner supplies those keys; subscriptions, navigation targets and mutations still address the qualified Session. Nesting applies to base rows. Both keeps the base and shortcut, Top suppresses only a promoted base without visible children, and In place creates no shortcuts. Shelf membership follows the mounted traversal and appends arrivals; severity and activity timestamps do not reorder it. The previous presented index supplies retained order, while current admitted rows supply live facts and immediately withdraw inaccessible or deleted entities. Header eligibility counts can therefore differ from held membership.

The existing public multi-selection reducer accepts an optional occurrence-to-entity
projection. Visible order, range anchors and keyboard focus address occurrences;
selection membership and counts address distinct entities. Consumers without
mirrored rows keep the original one-key-per-entity behavior. Session drag payloads
remain qualified entities while origin geometry identifies the initiating copy.

An active pointer or keyboard carry retains occurrence positions, not stale row
facts or revoked membership. At the entity runtime's effect-dispatch boundary,
the list releases that presentation freeze before an optimistic Section mutation
publishes. Row placement, full Section counts and failure rollback then follow
the same live organization projection; the captured source and Account authority
remain with the pending effect until settlement. The Scheduled/Drafts support
cell uses the existing measured-row registry only to exclude its rectangle from
drop admission. It is not an entity or a target, and pointer movement does not
remeasure it.

The development filter also carries qualified Project include/exclude selections, canonical awareness statuses and `underSessionId`. Its shared predicate returns match, miss or unavailable: a locked Project never satisfies an exclusion, and absent producer facts never become proof of a match. Under delegates to the existing server-owned subtree query and has a distinct query-cache identity; an ordinary list page cannot answer it. Session lists and Boards apply local Project/status facets after authorized structural membership. Current Session listing rows project their existing owner Account: “Started by me” requires protected origin `none` and that owner equal to the viewer Account. Names, Bot labels and daemon fields never establish it. Older Homes or cold placeholders retain ordinary list compatibility, but missing ownership/origin facts remain unavailable for rule matching. Follow rule preview uses that same predicate, reports explicit complete/partial/unavailable coverage, and never enrolls its matches. Private persistence, Account-mode conversion and source delivery have their own development integration checks; filter or preview success alone does not certify them.

In 0.3 development, a restricted Session-runtime credential may explicitly list **Under itself** through that same server proof. The result includes its root and readable managed descendants, traversing unreadable intermediates without disclosing them. The server rechecks the runtime binding, graph membership and access before returning the page. These are read-only shared Session projections; Account-private Follow, read/attention state, pins and owner metadata are excluded. Another root, an unscoped Account list and private Account filter facets remain refused. A worker's encrypted content remains locked without its own admitted key; the coordinator's key is never reused for it.

The Run arm of [`SessionItem`](../apps/ui/sources/components/sessions/shell/SessionItem.tsx) uses the shared row geometry and Work status treatment. It reads authoritative admission starter and private authored-step progress, not inferred origin or public invocation counts. Contextual search indexes private title and Where through the same list search owner; it does not read exact Run detail or transcripts. Partial Run windows remain partial after local filtering. A selected Home not served by the active Account window also keeps the List and Board incomplete; mounting a Home alone does not justify pruning its saved Run positions. There is no separate Workflow History renderer or Triggered tab; Started by selects trigger-origin Runs.

### Session sections (0.3 development)

Account sections project the existing opened organization folder definitions and
assignments. Their Home-qualified addresses distinguish equal local ids across
Homes; section membership spans Projects and Machines within that Account. The
existing full-assignment snapshot supplies membership independently of loaded
Session bodies. The admitted projection records coverage only after a successful
`includeAllFolderAssignments` response, not an exact/partial request or the older
Home's missing-route compatibility fallback. Scoped updates preserve that evidence;
Account retirement clears it. An unloaded or lead-displayed member still belongs
to its section. Empty copy requires known zero membership; unavailable coverage
is not zero. Archive all reads exact membership through the same snapshot owner.

Section selection uses the controlled `SessionSection` projection from the
organization domain, with no picker-owned loader. Names and icons use the shared
Protocol display reader, including retained 0.2 folder content and locked states.
Its optional UI-only legacy context carries admitted ancestor displays and the
existing normalized workspace context for breadcrumb/same-name disambiguation.
Locked or missing ancestors remain unavailable; this context never selects where
a Session executes and does not expand the strict public Action result.
The folder record's `sortKey` supplies section order. Existing folder transport and
the legacy importer retain identity and membership; they are not another section
store. See [Actions](actions.md) for mutation, removal and mixed-version semantics.
Creating a section writes only that new definition after the last valid fractional
key (or at the first key if none exists). Unrelated locked displays and retained
null, duplicate or invalid sibling keys stay untouched; creation is not an order
repair. Explicit section reorder retains its separate repair contract.

### Inbox attention sources (0.3 development)

[`workflowLibraryReads.ts`](../apps/ui/sources/components/workflows/library/workflowLibraryReads.ts) owns both the managed Workflow `attention` window and the ordinary `automationAttention` window. They share Account lifetime, read status, paging and the one Run fact map. Ordinary attention uses the existing Automation V3 public-summary projection through `GET /v3/automations/runs?attention=required`; it includes failures before a Session exists and excludes accepted managed Runs, whose attention belongs to the Workflow predicate. It never opens per-Run history or private content to build the list.

[`useWorkflowAttentionSource.tsx`](../apps/ui/sources/hooks/inbox/useWorkflowAttentionSource.tsx) adapts those windows for Inbox without another loader or attention policy. A refresh restates the loaded attention frontier; a failed refresh keeps last-known rows and exposes its failure and observation time. Account retirement withdraws the old projection and rejects late pages. [`useInboxModel.tsx`](../apps/ui/sources/hooks/inbox/useInboxModel.tsx) exposes `automationAttentionItems`, each with a public Run summary and the exact `/automations/[id]/runs/[runId]` route. Membership clears through existing Run state changes or deletion, not a new Inbox dismissal operation. This is a data-source contract, not a claim that Inbox presentation or loaded-runtime certification is complete.

Opt-in Usage notices consume the existing Account Artifact sync and Inbox branch, not a Session-shaped subject or another notice store. [`usageNoticeArtifacts.ts`](../apps/ui/sources/sync/domains/artifacts/usageNoticeArtifacts.ts) admits only current-Account-owned, non-public, open notices with an actually opened matching strict body; a header alone does not establish membership. Existing Artifact detail demand and Account-change invalidation supply that body. Inbox dismissal uses the captured-Account UI Action owner to read the actual current revision and change only the notice status through the existing Artifact CAS writer. Generic private notice authoring, retagging, sharing and public links remain denied; badges retain the shared attention policy.

These are unreleased 0.3 development contracts. Focused producer and Inbox owner tests do not establish loaded-runtime notification creation, cross-device arrival or delivery by a third-party channel.

## Contributor rules

- Consume the existing model, List engine, Collection and detail geometry before creating a page-local generic collection. A domain-specific composition is fine; a duplicate selection/layout/visit-memory owner is not.
- Keep data acquisition, currentness and mutations at the caller's domain owner. Report partial or unavailable windows honestly rather than implying a complete result after filtering loaded rows.
- Derive every presentation from one item anatomy and stable keys. Controls inside a card retain their own press/focus target rather than opening the card accidentally.
- Use shared presentation metrics and semantic theme/accessibility bindings. Do not copy geometry or motion constants from a plan or specimen.

## Related

[Plugin platform](plugin-platform.md), [surface states](surface-states.md), [DESIGN.md](../DESIGN.md), [UI instructions](../apps/ui/AGENTS.md).
