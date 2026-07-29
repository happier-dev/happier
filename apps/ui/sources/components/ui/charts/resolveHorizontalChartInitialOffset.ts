export function resolveHorizontalChartInitialOffset(input: Readonly<{
    contentWidth: number;
    viewportWidth: number;
    /**
     * Column stride (cell + gap) for grids whose columns carry a left-anchored
     * label (e.g. the heatmap month row). When set, the end-anchor snaps UP to
     * the next column boundary so the leftmost visible column always starts at
     * its left edge — its label can never be clipped on the left ("Sep" → "ep",
     * C-3). The extra travel past the raw overflow is absorbed by matching
     * trailing padding (`resolveHorizontalChartTrailingPad`) so the newest
     * column stays fully visible on the right.
     */
    columnStride?: number;
}>): number {
    const overflow = Math.max(0, input.contentWidth - input.viewportWidth);
    if (overflow <= 0) {
        return 0;
    }
    return overflow + resolveHorizontalChartTrailingPad(input);
}

/**
 * Trailing content padding that turns the raw end-anchor overflow into an exact
 * multiple of `columnStride`, so `resolveHorizontalChartInitialOffset` can snap
 * the leftmost visible column to a boundary (C-3) without clipping the newest
 * column on the right. Returns 0 when there is no stride or no overflow.
 */
export function resolveHorizontalChartTrailingPad(input: Readonly<{
    contentWidth: number;
    viewportWidth: number;
    columnStride?: number;
}>): number {
    const overflow = Math.max(0, input.contentWidth - input.viewportWidth);
    const stride = input.columnStride ?? 0;
    if (overflow <= 0 || stride <= 0) {
        return 0;
    }
    const remainder = overflow % stride;
    return remainder === 0 ? 0 : stride - remainder;
}

/**
 * The viewport width used for end-anchoring. The window-minus-inset estimate is
 * only a pre-layout guess — inside a modal/panel the real viewport can be far
 * narrower than the window, which under-anchors the chart and leaves the
 * newest columns clipped off-screen (D-R3-1). Once the frame has measured its
 * own layout, the measured width wins.
 */
export function resolveHorizontalChartViewportWidth(input: Readonly<{
    windowWidth: number;
    viewportInset: number;
    measuredWidth: number | null;
}>): number {
    if (input.measuredWidth != null && input.measuredWidth > 0) {
        return input.measuredWidth;
    }
    return Math.max(0, input.windowWidth - input.viewportInset);
}
