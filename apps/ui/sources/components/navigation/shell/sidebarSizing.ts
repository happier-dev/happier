const SIDEBAR_BASE_MAX_PX = 480;
const SIDEBAR_MAX_PX_CAP = 720;
const SIDEBAR_MAX_PCT = 0.5;

export function resolveSidebarDockMaxWidthPx(windowWidthPx: number): number {
    if (!Number.isFinite(windowWidthPx) || windowWidthPx <= 0) return SIDEBAR_BASE_MAX_PX;
    const pctMax = Math.floor(windowWidthPx * SIDEBAR_MAX_PCT);
    return Math.max(SIDEBAR_BASE_MAX_PX, Math.min(SIDEBAR_MAX_PX_CAP, pctMax));
}
