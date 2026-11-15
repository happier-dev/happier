// Host-only: how a full widget group stacks on a phone (not part of the governed public plugin API).
// Exported before the public barrel so its leaf module evaluates first: host modules reached through the
// public barrel's import cycle read this binding during evaluation (Systemic 2026-11-10 16:42Z).
export { orderWidgetGroupCellsForStack } from './layout/widgetGroupLayout.js';
export * from './index.public.js';
// Host-only: the page count line a core main screen's head draws under its band; plugins reach the same owner
// through `PageHeader`'s `count` (one drawing, one formatting rule).
export { formatHappierPageCount, HappierPageCountLine, type HappierPageCountLineTextRender } from './layout/PageCountLine.js';
// Host-only: the one rule between list and column rows, for core rows (column rows, Sessions) that draw it themselves;
// plugin rows draw it through `List.Item`.
export {
  HappierListRowFollowedContext,
  HappierListRowPrecedesSelectedContext,
  HappierListRowRule,
  resolveHappierCollectionRowTextStartPx,
  resolveHappierListRowRuleShown,
} from './collection/CollectionList.js';
// Host-only: the one search-behind-a-magnifier rule a core main screen's head shares with a plugin collection page.
export { useHappierSearchDisclosure, type HappierSearchDisclosure } from './collection/searchDisclosure.js';
// Host-only: how a shrink-wrapping container (a popover, a capture window) places a sized state.
export { HappierSurfaceStateFit } from './state/InfoState.js';
// Host-only: a tab bar shows the pressed tab before its owner builds the new surface (P03-TAB-SWITCH). Core bars and
// the public Tabs draw through it; not part of the governed public plugin API.
export { useHappierTabSelection } from './navigation/tabSelection.js';
// Host-only: a body presented away from its shell (a retained popover or dialog body) reads the shell's material plane.
export { HappierMaterialPlaneTransfer, useContainingHappierMaterialPlane } from './layout/Surface.js';
// Host-only: the one roving tab-stop rule, for app composites that bind their own focus targets (the composer's
// Agent rail). Not part of the governed public plugin API.
export { resolveHappierRovingTabStop } from './collection/semantics.js';
// Host-only: the one clipped-preview owner, for core content excerpts (a quoted source message). Plugins use
// `ContentPreview` from the components barrel.
export { HappierCollapsibleBody, type HappierCollapsibleBodyActionProps } from './content/CollapsibleBody.js';
