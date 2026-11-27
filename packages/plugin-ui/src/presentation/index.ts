// Host-only: how a full widget group stacks on a phone (not part of the governed public plugin API).
// Exported before the public barrel so its leaf module evaluates first: host modules reached through the
// public barrel's import cycle read this binding during evaluation (Systemic 2026-11-10 16:42Z).
export { orderWidgetGroupCellsForStack } from './layout/widgetGroupLayout.js';
export { HappierThemeSurfaceScope, useHappierThemeSurfaceOverridesEnabled, useThemeSurfaceBinder, useThemeSurfaceBinding, useThemeSurfaceInspectionBinding, resolveThemeSurfaceState, resolveThemeSurfaceAddress, type ThemeSurfaceStateFacts } from './themeSurfaceBinding.js';
export { resolveHappierThemeSurfaceStyle } from './themeSurface.js';
// Host-only active semantic inspection; no portable registry or plugin ABI changes.
export { beginThemeSurfaceInspection, createThemeSurfaceInspectionBinding } from './themeSurfaceInspection.js';
export * from './index.public.js';
export { HappierSeriesTrailingReadingContext } from './data/StackedSeriesChart.js';
// Host-only: core's type scale draws the compact title and its inline control in the same text flow.
export { HappierPageHeaderInlineTitleContext } from './layout/PageHeader.js';
// Host-only: a host surface that stands its controls at one height of its own (a signed-out step) scopes its field boxes to it.
export { HappierFieldBoxHeightScope, useHappierFieldBoxScopeHeight } from './form/FieldBox.js';
// Host-only: which text edge a section's plain action stands on (`start` once it drops beneath the section's text), so a
// host action row can order its controls for that edge from the header's own measured decision.
export { HappierTextActionEdgeContext } from './interaction/textActionEdge.js';
// Host-only: the resting view a passive phone viewer of a Browser or Computer stream gets (the picture fills its pane).
export { fillViewTransform } from './media/gestureMapping.js';
// Host-only: the page count line a core main screen's head draws under its band; plugins reach the same owner
// through `PageHeader`'s `count` (one drawing, one formatting rule).
export { formatHappierPageCount, HappierPageCountLine, type HappierPageCountLineTextRender, type HappierPageCountPart, type HappierPageCountTone } from './layout/PageCountLine.js';
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
// Host-only: the core controller and its public plugin bindings use the same Automations section and picker.
export { HappierAutomationsSection, type HappierAutomationsSectionBindings } from './automations/AutomationsSection.js';
export { HappierAutomationSubjectPicker, type HappierAutomationSubjectPickerRow } from './automations/AutomationSubjectPicker.js';
// Host-only: the media gallery's tiles and line model (Files gallery, Details gallery, Session Media).
export {
  HAPPIER_MEDIA_GRID_METRICS,
  HappierMediaFolderTile,
  HappierMediaGridFootLine,
  HappierMediaGridHeading,
  HappierMediaGridRow,
  HappierMediaTile,
  HappierMediaTileSkeleton,
  buildHappierMediaGridLines,
  resolveHappierMediaGridGeometry,
  type HappierMediaGridLine,
  type HappierMediaGridSection,
} from './collection/MediaGrid.js';
