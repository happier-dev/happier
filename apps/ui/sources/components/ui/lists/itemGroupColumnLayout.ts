/**
 * The column-count rule for every multi-column list surface.
 *
 * Column count is decided by AVAILABLE WIDTH, and by nothing else. A viewport
 * class is a min-edge DEVICE heuristic: it reads a short, wide desktop window as
 * `compact` despite ample room for two columns, and a 500px pane inside a 1600px
 * window as `wide` despite there being room for one. Width is the only thing
 * that actually decides whether a second column fits, so it is the only owner.
 *
 * The floor is per-surface, not global: a title+subtitle list row needs far more
 * room than a metric tile, so each surface declares its own `minColumnWidthPx`
 * and the default below is the LIST-ROW one.
 */

/** Narrowest a list-row column may become before collapsing back to one column. */
export const ITEM_GROUP_COLUMN_MIN_WIDTH_PX = 320;

/** Horizontal gutter between adjacent columns. */
export const ITEM_GROUP_COLUMN_GAP_PX = 12;

/** Vertical gutter between stacked cards inside one column. */
export const ITEM_GROUP_COLUMN_ROW_GAP_PX = 12;

export function resolveItemGroupColumnCountForWidth(params: Readonly<{
    availableWidthPx: number;
    requestedColumns: number;
    minColumnWidthPx?: number;
    columnGapPx?: number;
}>): number {
    const requested = Math.floor(params.requestedColumns);
    if (!Number.isFinite(requested) || requested <= 1) return 1;

    const availableWidthPx = params.availableWidthPx;
    // A non-finite width means "not measured yet" (or an unconstrained container).
    // Fail to the safe single-column layout rather than guessing a wide viewport.
    if (!Number.isFinite(availableWidthPx) || availableWidthPx <= 0) return 1;

    const minColumnWidthPx = params.minColumnWidthPx ?? ITEM_GROUP_COLUMN_MIN_WIDTH_PX;
    const columnGapPx = params.columnGapPx ?? ITEM_GROUP_COLUMN_GAP_PX;
    if (!Number.isFinite(minColumnWidthPx) || minColumnWidthPx <= 0) return requested;

    for (let count = requested; count > 1; count -= 1) {
        const requiredWidthPx = (count * minColumnWidthPx) + ((count - 1) * columnGapPx);
        if (requiredWidthPx <= availableWidthPx) return count;
    }
    return 1;
}
