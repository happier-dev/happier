// Host-only: how a full widget group stacks on a phone (not part of the governed public plugin API).
// Exported before the public barrel so its leaf module evaluates first: host modules reached through the
// public barrel's import cycle read this binding during evaluation (Systemic 2026-11-10 16:42Z).
export { orderWidgetGroupCellsForStack } from './layout/widgetGroupLayout.js';
export * from './index.public.js';
// Host-only: the page count line a core main screen's head draws under its band; plugins reach the same owner
// through `PageHeader`'s `count` (one drawing, one formatting rule).
export { formatHappierPageCount, HappierPageCountLine, type HappierPageCountLineTextRender } from './layout/PageCountLine.js';
// Host-only: how a shrink-wrapping container (a popover, a capture window) places a sized state.
export { HappierSurfaceStateFit } from './state/InfoState.js';
// Host-only: the one roving tab-stop rule, for app composites that bind their own focus targets (the composer's
// Agent rail). Not part of the governed public plugin API.
export { resolveHappierRovingTabStop } from './collection/semantics.js';
// Host-only: the one clipped-preview owner, for core content excerpts (a quoted source message). Plugins use
// `ContentPreview` from the components barrel.
export { HappierCollapsibleBody, type HappierCollapsibleBodyActionProps } from './content/CollapsibleBody.js';
