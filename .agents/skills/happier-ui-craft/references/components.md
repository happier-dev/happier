# Components and owners

Search the code before trusting this list; owners move. If a concept is missing here, find its
owner, do not create one. Paths are under `apps/ui/sources/` unless stated.

## Values

| Concern | Owner |
| --- | --- |
| Colours, surfaces, borders, shadows | Unistyles theme tokens (`theme/`); no raw colours, no new tokens without a theme-profile decision |
| Type scale and weights (`regular`, `medium`, `bold`) | `constants/Typography.ts` + app `Text` / `TextInput` |
| Page column, title block, section spacing, sheet radius and insets, row insets, back-arrow gutter, stack breakpoint | `components/ui/lists/pageListMetrics.ts` |
| Row density (a section sets it with `ItemGroup density`) | `components/ui/lists/itemDensityMetrics.ts`, `useResolvedItemDensity.ts` |
| Raised edge (which side, which states drop it), the rim and their colours | `@happier-dev/plugin-ui/presentation` raisedEdge + `theme/raisedEdge.ts` |
| Elevation ladder by role | `shadowElevation.ts` |
| Focus ring | `border.focus` and its single focus-visible treatment |
| Motion durations and easing | `components/ui/motion/index.ts` (`motionTokens`) |
| Content width | `components/ui/layout` (`layout.ts`, `contentWidthMode.ts`) |

## Structure

| Need | Use |
| --- | --- |
| A configuration or detail page | `ItemList` (page presentation by default) + `PageHeader` (`components/ui/layout/PageHeader.tsx`: title, description, `actions`, `leading` mark, `meta` facts with icons, and a back slot filled by the navigation chrome); settings use `SettingsPageHeader`. Non-page lists explicitly use `presentation="grouped"`. |
| A section | `ItemGroup` with `title`, `description`, optional `action` (drops beneath the title on narrow widths); `surface="none"` for sheetless content (tiles, a button row) |
| A row | `Item` |
| Free content inside a sheet | `SectionContentRow` |
| A searchable setting row | `SettingRow` / `SettingAnchor` (`components/settings/shell/SettingRow.tsx`) + a `defineSettingsPage` declaration |
| A generic collection (list, table, board, grid + detail composition) | Public `Collection` in `@happier-dev/plugin-ui`, with the `useHappierCollection` model and layout owners in `/presentation`; see [Collection presentation](../../../../docs/collection-presentation.md). Optional visit-memory landing, drafts and route-owned open state use those owners |
| A table that opens rows into list + detail (PRs & Issues) | The public `Collection` (`@happier-dev/plugin-ui`): one item anatomy, column priorities, peek, `detail: 'auto'` with the table ⇄ split shared-element move; motion comes from the host (`PluginUiPresentationHost.collectionMotion`) |
| List + detail | `HappierListDetailLayout` (the Collection's split geometry); pages read its mode with `useHappierCollectionLayout`, index routes with `useHappierCollectionIndexView` |
| The list pane of a list + detail collection | `CollectionList` (`components/ui/lists/collection/CollectionList.tsx`, the app binding of `HappierCollectionList`) with `CollectionListGroupLabel` and `CollectionDraftRow` |
| Details beside a destination's page (a plugin, an item) | `DetailsPaneHost` (`components/appShell/panes/details/DetailsPaneHost.tsx`): pass `details={{ header, content }}` or null, `onCloseDetails`, and the page's `mainMinWidthPx`; the pane is full height, resizable, keeps its width, and overlays rather than squeezing the page. On phones (`useDetailsPaneAvailable()` false) push a page instead. Never a page-local drawer |
| A side pane's header | `PaneHeader` (title, subtitle, actions, close) — the same band as the session header; the right sidebar's title comes from the tab registry (`RightSidebarPaneHeader`) |
| The columns themselves (main, right sidebar, details, bottom, action rail) | `PaneColumnsHost` (`components/appShell/panes/PaneColumnsHost.tsx`) — widths, min/max, docked vs overlay, persisted width per pane (`PANE_SIZING_DEFAULTS`); Session/Project panes reach it through `AppPaneScopeHost` |
| Expand in place | `ExpandableItem` (the app's motion binding of `HappierDisclosure`) |
| Empty: a whole page or pane, or one line in a list or rail | `EmptyState` (`layout="page"` / `"line"`; `primaryAction`, `actionUnavailableReason`) |
| A pane, details or app-surface state (empty that invites, loading, offline, error, denied) | `SurfaceStateCard` (`components/ui/surfaces`): container-owned `size` through `SurfaceStateSizeProvider`, a primary `action`, optional quiet secondary action, `note` + `learnMore`, present-tense `live`, and `diagnosticCode` behind Details; `size="line"` is the compact in-list composition. See [surface states](../../../../docs/surface-states.md) |
| Stale content (retained, behind) | `SurfaceFreshnessLine` under the header ("As of 10:42 · devbox isn't answering · Retry"); never over an empty body |
| The mark at the head of an entity page or row | `PageHeaderMarkSlot` (bare fixed-size slot for both logos and glyphs) |
| Menus, pickers, tooltips | `Popover` + `FloatingOverlay`; searchable choices in a popover use `SelectionList` content full-bleed; compact pickers anchored to a chip use `portal.sizeToContent`. Tooltips are `AnchoredTooltip` (via `IconButton` `tooltip` / `Tooltip`): content-sized, centred on the anchor (`anchorAlign: 'center'` + `sizeToContent`), `flip`ped and clamped to the window |
| A menu row | `SelectableRow presentation="menu"` (what `DropdownMenu` and `ActionListSection` draw): full content width at `MENU_ROW_METRICS.insetPx`, radius concentric with the surface (`FLOATING_OVERLAY_METRICS`), highlight a fill, never an outline |
| A form field | `FieldItem` / `FieldTextInput` (one field shape: `components/ui/forms/fieldBox.ts`); lists of values `StringListField` |
| A pressable surface | `HappierPressable` — its focus ring follows `:focus-visible` on web, so a mouse press never leaves a ring and keyboard focus always shows one. A control that is not a `HappierPressable` paints its ring through `isHappierFocusVisible` / `resolveHappierFocusRingVisible` (`@happier-dev/plugin-ui/presentation`), never from React Native Web's raw `focused` |

## Control decision table

| The user is choosing… | Control | Owner |
| --- | --- | --- |
| On / off | Switch | `Item` with switch |
| One of 2–4 short options | Segmented, all visible; announces a radio group, an unavailable option says why (`unavailableReason`) | `SegmentedChoiceItem`; outside a row, `SegmentedTabBar role="radiogroup"` |
| A fixed choice inside a typed input form (Actions, Workflows, widget inputs) | The shared option list of the input field, at any option count | `HappierInputField` (plugin-ui) |
| Which view of the same content to show (Steps · Flow, list filters, chart lenses) | Segmented view switch; announces tabs | `SegmentedTabBar` (default `role="tablist"`) |
| One of many, or long labels | Bordered field select | `DropdownMenu` (field trigger on pages) |
| A value on a scale with steps | Slider with end glyphs | `components/ui/forms/Slider.tsx` |
| Filter a list inside a rail or popover | Compact bordered search field (the same one as the settings sidebar) | `components/ui/forms/CompactSearchField.tsx` |
| Something that changes how the app looks | Visual tiles with real previews | `SelectionTiles variant="visual"` |
| One of a few actions that deserve space | Action tiles | `SelectionTiles variant="action"` |
| A destination | Summary + chevron | `Item` with `detail` + chevron |
| An operation | Inline button | `RoundButton` (`display` primary / secondary / destructive) |
| A machine scope | Header chip | `MachineAdministrationTargetSelector presentation="chip"` |
| Rare operations on an entity | `⋯` menu | `IconButton` + `Popover` |

Rules that come with the table:
- Visual previews render the real component (session row, avatar, theme window) at static props.
  No subscriptions, no RPCs, no drawn replicas.
- A slider exists only for a real ordered scale; its steps are the setting's real values.
- Typed input forms never hand-pick a segmented control for small choices: the field owner decides
  their presentation once, for every form.
- A "+" with more than one way to add is a menu, not a guess at the most common path.
- One primary `RoundButton` per view. Dark themes use an inverted primary (light fill, dark text);
  check that a filled secondary does not read as disabled, and use `display="destructive"` for the
  irreversible action.
- Visual tile rows fill the section width as equal tiles; action tiles wrap to one column on phones.

## Status and badges

- `StatusPill` for a short state next to a title (Beta, Saved, Installed). Neutral unless the state
  asks for attention.
- A dot only for trouble (needs sign-in, offline, failed). A green dot for "fine" is noise, except
  presence (online) where it is the identity of the state.
- Counts are quiet and tabular.

## Identity marks

- Agents, providers and services use their contributed brand marks through the catalog/registry
  owners (never branch on ids in generic UI). People use the avatar owner. Machines and devices use
  the device icons. A missing mark is a defect to fix at the catalog, not a blank space.
- **Row icons (rule b)** go through `Item`'s leading column (`icon`): one family, one size,
  `text.secondary`. Navigation rows and hub tiles have one; preference rows do not. Lane S2 owns the
  leading-column change in `Item`; do not size or colour row icons at the call site.
- **Glyphs and logos stand alone.** Icons and agent, provider and service marks have no backing
  tile, fill or border. Only avatars and an app icon rendered as an actual app icon are exceptions.
  Empty-state glyphs also remain bare.

## Plugins

Plugins build the same anatomy from `@happier-dev/plugin-ui` primitives. Do not reproduce host
anatomy inside a plugin, and do not add a host-only primitive a plugin would need; expose it.
The shared owners live in `@happier-dev/plugin-ui/presentation` and core consumes them in place:
`HappierPageHeader` (core `PageHeader` / public `PageHeader`), `HappierPageSectionHeader` +
`HappierPageSheet` (core page `ItemGroup` / public titled `ItemGroup`), `HAPPIER_PAGE_METRICS` and
`HAPPIER_PAGE_TEXT` (geometry and type scale behind `pageListMetrics.ts` and `pageTitleTypography`),
`HAPPIER_EMPTY_STATE_FRAME` (both `EmptyState`s), the shared switch / field-box / segmented visuals
and the tile owner. A new page-anatomy value or behaviour lands in that owner, never in only one side.
