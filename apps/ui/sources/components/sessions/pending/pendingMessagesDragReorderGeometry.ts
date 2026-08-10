/**
 * Geometry of a pending-queue drag reorder, over MEASURED row heights only.
 *
 * M1 (2026-08-10). These helpers used to serve two jobs at once: deciding where a drag lands, and
 * LAYING OUT the queue — every row was `position: 'absolute'` at an offset computed here, so the
 * block's height was a Reanimated shared value fed from this arithmetic. Any row whose `onLayout`
 * had not landed yet was substituted with an estimate (the account setting
 * `transcriptPendingQueueReorderRowHeightPx`, default 72), which is why the block painted a
 * three-step 20.25 -> 92.25 -> 68.25 sequence on ~2 sends in 12: a seed height, the estimate, then
 * the truth. The rows now stay in normal flow and the block is sized by them, so an unmeasured row
 * has no layout consequence at all and none of these functions substitutes anything for it: a row
 * that has not laid out has no painted extent, and 0 is the truthful answer.
 *
 * They stay worklets because the drag runs on the UI thread.
 */

function resolveRowHeightPx(heights: Readonly<Record<string, number>>, id: string): number {
    'worklet';
    const height = heights[id];
    return typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : 0;
}

/** Distance from the top of the list to the top of `id`, in the given order. */
export function resolveRowOffsetPx(
    orderedIds: ReadonlyArray<string>,
    heights: Readonly<Record<string, number>>,
    id: string,
): number {
    'worklet';
    let y = 0;
    for (const current of orderedIds) {
        if (current === id) return y;
        y += resolveRowHeightPx(heights, current);
    }
    return y;
}

/** Total painted extent of the rows — the auto-scroll bound during a drag. */
export function resolveRowsTotalHeightPx(
    orderedIds: ReadonlyArray<string>,
    heights: Readonly<Record<string, number>>,
): number {
    'worklet';
    let y = 0;
    for (const current of orderedIds) {
        y += resolveRowHeightPx(heights, current);
    }
    return y;
}

/** Which index a row whose vertical CENTRE sits at `centerY` should occupy. */
export function findTargetIndexAtCenterY(
    orderedIds: ReadonlyArray<string>,
    heights: Readonly<Record<string, number>>,
    centerY: number,
): number {
    'worklet';
    let y = 0;
    for (let i = 0; i < orderedIds.length; i += 1) {
        const id = orderedIds[i]!;
        const heightPx = resolveRowHeightPx(heights, id);
        const midpoint = y + heightPx / 2;
        if (centerY < midpoint) return i;
        y += heightPx;
    }
    return orderedIds.length - 1;
}

export function moveIdToIndex(
    orderedIds: ReadonlyArray<string>,
    id: string,
    nextIndex: number,
): string[] {
    'worklet';
    const currentIndex = orderedIds.indexOf(id);
    if (currentIndex < 0) return orderedIds.slice();
    if (currentIndex === nextIndex) return orderedIds.slice();
    const next = orderedIds.slice();
    next.splice(currentIndex, 1);
    next.splice(nextIndex, 0, id);
    return next;
}

/**
 * How far a row must be TRANSLATED from the position it occupies in the rendered (flow) order to
 * sit where the in-progress drag order puts it. Zero whenever the two orders agree, which is every
 * frame outside a drag — so an idle queue paints as plain flow with no transform at all.
 */
export function resolveRowDragDisplacementPx(params: Readonly<{
    flowIds: ReadonlyArray<string>;
    orderedIds: ReadonlyArray<string>;
    heights: Readonly<Record<string, number>>;
    id: string;
}>): number {
    'worklet';
    return resolveRowOffsetPx(params.orderedIds, params.heights, params.id)
        - resolveRowOffsetPx(params.flowIds, params.heights, params.id);
}
