export type ResolveTranscriptNavigationRailPreviewPlacementInput = Readonly<{
    /** Focused marker top in rail-viewport coordinates (scroll already applied). */
    markerTopPx: number;
    railWidthPx: number;
    paneHeightPx: number;
    paneWidthPx: number;
    /** Rail viewport offset from the pane top (rail is vertically centered). */
    viewportOffsetTopPx: number;
    /** Measured preview height; null before the first layout pass. */
    previewHeightPx: number | null;
    requestedMaxWidthPx?: number;
}>;

export type TranscriptNavigationRailPreviewPlacement = Readonly<{
    leftPx: number;
    topPx: number;
    maxWidthPx: number;
}>;

const RAIL_PREVIEW_GUTTER_PX = 8;
const RAIL_PREVIEW_EDGE_MARGIN_PX = 8;
const RAIL_PREVIEW_ANCHOR_BIAS_PX = 24;
const RAIL_PREVIEW_HEIGHT_ESTIMATE_PX = 72;
// Wide enough for the bold title + 2-3 lines of message text to read well.
const RAIL_PREVIEW_DEFAULT_MAX_WIDTH_PX = 320;
const RAIL_PREVIEW_MIN_MAX_WIDTH_PX = 120;

function finitePositive(value: number | null | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value: number, fallback = 0): number {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Places the rail hover preview beside the rail (fixed ~8px gutter) and clamps
 * it inside the pane using the measured preview size. Coordinates are relative
 * to the rail container, which sits at `viewportOffsetTopPx` inside the pane.
 */
export function resolveTranscriptNavigationRailPreviewPlacement(
    input: ResolveTranscriptNavigationRailPreviewPlacementInput,
): TranscriptNavigationRailPreviewPlacement {
    const railWidthPx = finitePositive(input.railWidthPx, 0);
    const paneHeightPx = finitePositive(input.paneHeightPx, 0);
    const paneWidthPx = finitePositive(input.paneWidthPx, 0);
    const viewportOffsetTopPx = finiteNonNegative(input.viewportOffsetTopPx);
    const previewHeightPx = finitePositive(input.previewHeightPx, RAIL_PREVIEW_HEIGHT_ESTIMATE_PX);
    const markerTopPx = Number.isFinite(input.markerTopPx) ? input.markerTopPx : 0;

    const leftPx = railWidthPx + RAIL_PREVIEW_GUTTER_PX;

    const minTopPx = RAIL_PREVIEW_EDGE_MARGIN_PX - viewportOffsetTopPx;
    const maxTopPx = paneHeightPx - viewportOffsetTopPx - previewHeightPx - RAIL_PREVIEW_EDGE_MARGIN_PX;
    const anchoredTopPx = markerTopPx - RAIL_PREVIEW_ANCHOR_BIAS_PX;
    const topPx = Math.max(minTopPx, Math.min(anchoredTopPx, Math.max(minTopPx, maxTopPx)));

    const requestedMaxWidthPx = finitePositive(input.requestedMaxWidthPx, RAIL_PREVIEW_DEFAULT_MAX_WIDTH_PX);
    const paneConstrainedMaxWidthPx = paneWidthPx > 0
        ? paneWidthPx - leftPx - RAIL_PREVIEW_EDGE_MARGIN_PX
        : requestedMaxWidthPx;
    const maxWidthPx = Math.max(
        RAIL_PREVIEW_MIN_MAX_WIDTH_PX,
        Math.min(requestedMaxWidthPx, paneConstrainedMaxWidthPx),
    );

    return { leftPx, topPx, maxWidthPx };
}
