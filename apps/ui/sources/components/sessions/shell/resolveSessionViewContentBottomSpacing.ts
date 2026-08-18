export type SessionViewChatBottomSpacing = 'default' | 'none';

export const SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX = 32;
export const SESSION_VIEW_EDGE_ALIGNED_CONTENT_BOTTOM_GAP_PX = 16;
export const SESSION_VIEW_EDGE_ALIGNED_WIDTH_GUTTER_PX = 32;
export const SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX = 8;

type SeededSessionViewContentWidth = Readonly<{
    measuredWidthPx: number;
    windowWidthPx: number;
}>;

// First-frame width source for the session content area, keyed by a STABLE pane/surface id (never by
// session id). The inner session subtree remounts on every session switch (`key={sessionId}`), which
// would otherwise reset the measured content width to `null` and flip the bottom spacing for one frame
// on narrow/multi-pane layouts. Persisting the last measured width per pane surface lets the remounted
// subtree seed its first committed frame with the settled width.
//
// The cache is intentionally invalidated whenever the window width changes (a real resize), so a stale
// pane width is never reused after the layout actually changed. Keying by pane/surface (not session)
// also prevents one pane's width from leaking into another pane.
const sessionViewContentWidthBySurface = new Map<string, SeededSessionViewContentWidth>();

function isFiniteWidth(value: number): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function readSeededSessionViewContentWidth(params: Readonly<{
    surfaceId: string;
    windowWidthPx: number;
}>): number | null {
    const seeded = sessionViewContentWidthBySurface.get(params.surfaceId);
    if (!seeded) return null;
    if (!isFiniteWidth(params.windowWidthPx)) return null;
    if (seeded.windowWidthPx !== params.windowWidthPx) return null;
    return seeded.measuredWidthPx;
}

export function rememberSessionViewContentWidth(params: Readonly<{
    surfaceId: string;
    measuredWidthPx: number;
    windowWidthPx: number;
}>): void {
    if (!isFiniteWidth(params.measuredWidthPx)) return;
    if (!isFiniteWidth(params.windowWidthPx)) return;
    sessionViewContentWidthBySurface.set(params.surfaceId, {
        measuredWidthPx: params.measuredWidthPx,
        windowWidthPx: params.windowWidthPx,
    });
}

export function forgetSessionViewContentWidthSurface(surfaceId: string): void {
    sessionViewContentWidthBySurface.delete(surfaceId);
}

export function resolveSessionViewAvailableWidth(params: Readonly<{
    measuredContentWidthPx: number | null;
    windowWidthPx: number;
}>): number {
    if (
        typeof params.measuredContentWidthPx === 'number' &&
        Number.isFinite(params.measuredContentWidthPx) &&
        params.measuredContentWidthPx > 0
    ) {
        return params.measuredContentWidthPx;
    }

    return params.windowWidthPx;
}

export function resolveSessionViewContentBottomSpacing(params: Readonly<{
    chatBottomSpacing: SessionViewChatBottomSpacing;
    safeAreaBottomPx: number;
    availableWidthPx: number;
    contentMaxWidthPx: number;
    defaultContentBottomGapPx?: number;
    inputOuterBottomPaddingPx?: number;
    /** True while the software keyboard is open: every bottom gap is a composer-to-keyboard gap then, so it collapses. */
    softwareKeyboardOpen?: boolean;
}>): number {
    if (params.chatBottomSpacing === 'none') return 0;
    if (params.softwareKeyboardOpen === true) return 0;

    const safeAreaBottomPx = Number.isFinite(params.safeAreaBottomPx)
        ? Math.max(0, params.safeAreaBottomPx)
        : 0;
    const defaultContentBottomGapPx = Number.isFinite(params.defaultContentBottomGapPx)
        ? Math.max(0, params.defaultContentBottomGapPx ?? SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX)
        : SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX;
    const contentFillsMainWidth =
        Number.isFinite(params.availableWidthPx) &&
        Number.isFinite(params.contentMaxWidthPx) &&
        params.availableWidthPx <= params.contentMaxWidthPx + SESSION_VIEW_EDGE_ALIGNED_WIDTH_GUTTER_PX;
    const inputOuterBottomPaddingPx = Number.isFinite(params.inputOuterBottomPaddingPx)
        ? Math.max(0, params.inputOuterBottomPaddingPx ?? 0)
        : 0;
    const bottomGapPx = contentFillsMainWidth
        ? Math.max(0, Math.min(SESSION_VIEW_EDGE_ALIGNED_CONTENT_BOTTOM_GAP_PX, Math.round(defaultContentBottomGapPx / 2)) - inputOuterBottomPaddingPx)
        : defaultContentBottomGapPx;

    return safeAreaBottomPx + bottomGapPx;
}
