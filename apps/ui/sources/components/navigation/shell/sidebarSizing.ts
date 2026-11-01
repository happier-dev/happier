import type { WindowFoldMetrics } from '@/utils/platform/windowFoldMetrics';

export const SIDEBAR_COLLAPSED_WIDTH_PX = 72;
export const SIDEBAR_DOCK_MIN_WIDTH_PX = 250;

const SIDEBAR_BASE_MAX_PX = 480;
const SIDEBAR_MAX_PX_CAP = 720;
const SIDEBAR_MAX_PCT = 0.5;

export function resolveSidebarDockMaxWidthPx(windowWidthPx: number): number {
    if (!Number.isFinite(windowWidthPx) || windowWidthPx <= 0) return SIDEBAR_BASE_MAX_PX;
    const pctMax = Math.floor(windowWidthPx * SIDEBAR_MAX_PCT);
    return Math.max(SIDEBAR_BASE_MAX_PX, Math.min(SIDEBAR_MAX_PX_CAP, pctMax));
}

/**
 * Book layout for a window split by one vertical crease: the expanded docked sidebar ends on the
 * crease, so the list sits on the left page and the content on the right. Returns null whenever
 * the user's own (persisted) width applies instead — no metrics, no division, a horizontal or
 * partial-height division, several divisions, or a crease outside the dock bounds.
 *
 * `sidebarStartPx` is where the sidebar's content begins in window points (its leading inset);
 * rects are in window points too, compared at whole-point precision because native geometry is float.
 */
export function resolveFoldAlignedSidebarWidthPx(params: Readonly<{
    foldMetrics: WindowFoldMetrics | null;
    sidebarStartPx: number;
}>): number | null {
    const metrics = params.foldMetrics;
    if (!metrics || metrics.divisions.length !== 1) return null;
    const division = metrics.divisions[0];
    const spansWindowHeight =
        Math.round(division.y) === 0
        && Math.round(division.y + division.height) === Math.round(metrics.height);
    if (!spansWindowHeight || division.width >= division.height) return null;

    const widthPx = division.x - params.sidebarStartPx;
    if (widthPx < SIDEBAR_DOCK_MIN_WIDTH_PX || widthPx > resolveSidebarDockMaxWidthPx(metrics.width)) return null;
    return widthPx;
}
