/**
 * Pure geometry for the dashboard scrub interactions (trend crosshair,
 * activity lens). No React, no Reanimated — unit-tested in isolation and
 * shared by every scrubbable section so index math never forks.
 */

export type ScrubRowLayout = Readonly<{
    /** Leading padding before the first cell (px). */
    leadingPx: number;
    /** Cell width (px). */
    cellPx: number;
    /** Gap between cells (px). */
    gapPx: number;
    /** Number of cells. */
    count: number;
}>;

/**
 * Map an x offset (in the row's own coordinate space) to the cell index under
 * it. Points in a gap resolve to the nearest cell; points before the first /
 * after the last cell clamp to the edges. Returns null for an empty row.
 */
export function resolveScrubIndex(x: number, layout: ScrubRowLayout): number | null {
    if (layout.count <= 0 || layout.cellPx <= 0) {
        return null;
    }
    const stride = layout.cellPx + layout.gapPx;
    const raw = (x - layout.leadingPx + layout.gapPx / 2) / stride;
    return Math.min(layout.count - 1, Math.max(0, Math.floor(raw)));
}

/** Center x of a cell, for positioning the crosshair over the scrubbed cell. */
export function scrubCellCenterX(index: number, layout: ScrubRowLayout): number {
    const stride = layout.cellPx + layout.gapPx;
    return layout.leadingPx + index * stride + layout.cellPx / 2;
}

/**
 * Clamp a floating lens/bubble of `lensWidth` so it stays inside
 * `[0, containerWidth]` while trying to center on `anchorX`.
 */
export function clampLensLeft(anchorX: number, lensWidth: number, containerWidth: number): number {
    const ideal = anchorX - lensWidth / 2;
    return Math.min(Math.max(0, ideal), Math.max(0, containerWidth - lensWidth));
}
