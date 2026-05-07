export type SessionViewChatBottomSpacing = 'default' | 'none';

export const SESSION_VIEW_DEFAULT_CONTENT_BOTTOM_GAP_PX = 32;
export const SESSION_VIEW_EDGE_ALIGNED_CONTENT_BOTTOM_GAP_PX = 16;
export const SESSION_VIEW_EDGE_ALIGNED_WIDTH_GUTTER_PX = 32;
export const SESSION_VIEW_AGENT_INPUT_OUTER_BOTTOM_PADDING_PX = 8;

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
}>): number {
    if (params.chatBottomSpacing === 'none') return 0;

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
