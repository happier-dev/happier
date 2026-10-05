# Collection presentation ownership

A Collection presents keyed items through one headless model, shared list/table/board/grid anatomy and responsive detail composition. The caller owns the data, route, actions and view preference. The presentation layer owns how those facts fit together.

This page describes **0.3 development source**. It promotes implemented owners, not the historical Collection plan's rollout or unverified fidelity claims.

## Model and presentation

[`useHappierCollection`](../packages/plugin-ui/src/presentation/collection/useCollection.ts), exported from `@happier-dev/plugin-ui/presentation`, composes grouping, order, filter, window completeness, focus, selection, expanded keys, route-controlled `openKey`, visit memory and drafts. Multiple selection reuses the existing [`multiSelection.ts`](../packages/plugin-ui/src/presentation/collection/multiSelection.ts) store/reducer. The model calls `onOpenChange`; it does not navigate or persist domain items.

Initial landing is optional: when the consumer supplies visit memory, items are ready and the measured mode is split, the model chooses the last visited available item, otherwise the first. Overview indexes may omit this policy. A draft uses a separate key and title store; it is not silently persisted as a real item.

The public [`Collection`](../packages/plugin-ui/src/components/Collection.tsx) draws one `CollectionAnatomy` through the existing [`List`](../packages/plugin-ui/src/components/List.tsx) engine and card composition. `collectionTable.ts` owns [presentation and detail decisions](../packages/plugin-ui/src/presentation/collection/collectionTable.ts): table/list can split when their minima fit; board/grid use the host details pane when available and otherwise push the detail. A pane host's placement takes precedence over an in-page split. Before measurement the composition does not claim a wide layout.

An anatomy may supply a qualified page `destination` and shareable `subPath`, the same identity ordinary `openSurface` activation uses. The app presentation host adds workspace context menus, Cmd-click on Apple platforms / Ctrl-click elsewhere, Alt/middle-click kept tabs and href drag sources through its existing catalog/workspace owner; hosts without that presentation binding retain ordinary activation. These gestures request `mode: 'newTab'` (kept, non-preview); the separate fixed-strip pin is not changed. Collection rows merge these actions into the existing `List.Item` context, keyboard and overflow menu, retaining the row's own actions. Singleton destinations remain singletons. Core rows can decorate the shared item through `wrapItem` without forking its list/card anatomy or secondary controls.

All four presentations use the same search header, selection controls and `List.Item` row action/menu owner. Board column Lists do not replace the Collection's full selection inventory with their own mounted rows. Independent card actions remain separate targets: pressing Pin or an anatomy action never opens the item.

Selection keys keep the shared List's priority: Space selects when the optional multiple-selection capability is mounted; otherwise table Space peeks. Modified range-extension keys follow the store's visible eligible order. Ordinary arrows retain the presentation's spatial geometry, including the positions occupied by inactive primary items.

Multi-selection uses the shared store's anchor and focus: Shift-click selects a range, `x` toggles the focused row, Shift+Up/Down extends, and Escape clears. Command-click remains navigation even during selection. Session row menus retain Select; touch long-press still opens that menu, not selection. Once selection starts, ordinary row presses toggle and existing selection controls/action bars remain responsible for Done and bulk actions. Checkboxes are selection-mode-only, never a hover affordance.

The Collection model owns one logical focus key and spatial keyboard navigation across its presentations. Board has one primary-item tab stop across columns; left/right moves between columns and up/down within a column. List and Grid bind/reveal physical targets without independently choosing the Collection's cursor. Per-view scroll offsets and focused-item anchors, Board column anchors/vertical offsets, the horizontal Board offset and phone pager position belong to the same model. Re-entering a view restores its viewport once; refreshing data does not scroll it again. These are mount-lifetime facts, not cross-restart persistence. A host that replaces `renderPageScroller` remains responsible for its own page-scroller lifecycle; the current app uses the shared fallback scroller.

A grid card may draw the item itself in a `preview` band above its title (the anatomy's `preview` slot, grid only, pure, no requests); every card in the grid then reserves the band so rows stay equal. The Artifacts browser uses it for documents' first lines and code.

Use the actual `presentation` and `detail: 'auto' | 'none'` API; do not copy old plan examples that propose `views`, a generic `drawer` mode or `detail: 'peek'`. Expanding a row uses the disclosure/peek owner. Switching presentation can remount cells; keep the model, route and required detail continuity stable rather than promising universal row persistence.

`detailHeader(key)` supplies the selected item's title, optional subtitle and actions to the host details band. The host owns Close. `renderDetail(key, { headerHosted })` renders the same detail body in each container; when the header is hosted, omit the body's duplicate title and close controls. In a pushed or split detail, the caller keeps its inline header and route-owned back behavior.

Opening or replacing an item binds the public opaque focus target to the detail's first semantic `Heading` / `PageHeader`, or to the shared app `PaneHeader` when `detailHeader` is hosted. The existing presentation-host focus adapter performs the transfer and native accessibility announcement; no DOM traversal or second announcement service is involved. A data refresh does not re-request heading focus. Closing returns focus to the item's row/card through the model's physical-focus request.

## Layout and host bindings

Board callers can select `boardLayout="stacked"` for domain-approved phone sections or `"columns"` for status columns; omission retains the shared responsive column pager. Explicit columns share the available pane width. Grouping may retain empty axis positions (`retainEmpty`) on wide status boards; those columns take their header width and show one quiet empty line, while populated columns take the remaining width. Counts sit beside their titles, with no column dividers. The shared List primary gridcell stretches card bodies to their column inset, including stacked phone sections. Card collections with `detail="none"` omit the pane keyboard-hint bar. The model still owns cross-column arrows, one primary tab stop and viewport memory. `CollectionAnatomy.boardContent` supplies a domain card body inside that same physical interaction owner, not another press target or cursor. The Work Board keeps the model mounted when switching Canvas/By status, without rendering hidden cards, and requests its focused card again when the item route returns.

[`HappierListDetailLayout`](../packages/plugin-ui/src/presentation/collection/ListDetailLayout.tsx) owns split geometry and publishes the measured mode through [`collectionLayout.tsx`](../packages/plugin-ui/src/presentation/collection/collectionLayout.tsx). Consumers read `useHappierCollectionLayout` or `useHappierCollectionIndexView`; they do not mirror layout mode into another state/context.

The app's [`SettingsCollectionLayout`](../apps/ui/sources/components/settings/shell/SettingsCollectionLayout.tsx) binds that geometry to the nested route stack and keeps its detail stack mounted across wide/narrow composition. It is an adapter over the shared owner, not another split engine. Host motion comes through the Plugin UI presentation host; plugins do not acquire Reanimated or app-internal navigation dependencies to reproduce it.

## Sessions and Workflow Runs

In 0.3 development source, [`SessionsList`](../apps/ui/sources/components/sessions/shell/SessionsList.tsx) owns the mixed Sessions/Workflow Runs list, including the Workflows column's Runs view and `/workflows/runs`. `SessionListFilterV1` owns Show and Started by; the same Run predicate serves Board filter membership. The existing Account-scoped Workflow read windows supply Runs, and the existing parent-work nesting owner attaches step Sessions beneath their Run instead of presenting them as independent roots.

The Run arm of [`SessionItem`](../apps/ui/sources/components/sessions/shell/SessionItem.tsx) uses the shared row geometry and Work status treatment. It reads authoritative admission starter and private authored-step progress, not inferred origin or public invocation counts. Contextual search indexes private title and Where through the same list search owner; it does not read exact Run detail or transcripts. Partial Run windows remain partial after local filtering. A selected Home not served by the active Account window also keeps the List and Board incomplete; mounting a Home alone does not justify pruning its saved Run positions. There is no separate Workflow History renderer or Triggered tab; Started by selects trigger-origin Runs.

### Inbox attention sources (0.3 development)

[`workflowLibraryReads.ts`](../apps/ui/sources/components/workflows/library/workflowLibraryReads.ts) owns both the managed Workflow `attention` window and the ordinary `automationAttention` window. They share Account lifetime, read status, paging and the one Run fact map. Ordinary attention uses the existing Automation V3 public-summary projection through `GET /v3/automations/runs?attention=required`; it includes failures before a Session exists and excludes accepted managed Runs, whose attention belongs to the Workflow predicate. It never opens per-Run history or private content to build the list.

[`useWorkflowAttentionSource.tsx`](../apps/ui/sources/hooks/inbox/useWorkflowAttentionSource.tsx) adapts those windows for Inbox without another loader or attention policy. A refresh restates the loaded attention frontier; a failed refresh keeps last-known rows and exposes its failure and observation time. Account retirement withdraws the old projection and rejects late pages. [`useInboxModel.tsx`](../apps/ui/sources/hooks/inbox/useInboxModel.tsx) exposes `automationAttentionItems`, each with a public Run summary and the exact `/automations/[id]/runs/[runId]` route. Membership clears through existing Run state changes or deletion, not a new Inbox dismissal operation. This is a data-source contract, not a claim that Inbox presentation or loaded-runtime certification is complete.

## Contributor rules

- Consume the existing model, List engine, Collection and detail geometry before creating a page-local generic collection. A domain-specific composition is fine; a duplicate selection/layout/visit-memory owner is not.
- Keep data acquisition, currentness and mutations at the caller's domain owner. Report partial or unavailable windows honestly rather than implying a complete result after filtering loaded rows.
- Derive every presentation from one item anatomy and stable keys. Controls inside a card retain their own press/focus target rather than opening the card accidentally.
- Use shared presentation metrics and semantic theme/accessibility bindings. Do not copy geometry or motion constants from a plan or specimen.

## Related

[Plugin platform](plugin-platform.md), [surface states](surface-states.md), [DESIGN.md](../DESIGN.md), [UI instructions](../apps/ui/AGENTS.md).
