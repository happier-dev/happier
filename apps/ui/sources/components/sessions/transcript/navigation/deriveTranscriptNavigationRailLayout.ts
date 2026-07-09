export type TranscriptNavigationRailPlatformOS = 'web' | 'ios' | 'android' | 'native' | 'native-other';

export type TranscriptNavigationRailLayout = Readonly<{
    contentHeightPx: number;
    hiddenReason: 'native-platform' | 'below-width-threshold' | 'too-few-entries' | 'insufficient-gutter' | null;
    markerHeightPx: number;
    markerSpacingPx: number;
    overflow: boolean;
    railWidthPx: number;
    scrollTopPx: number;
    showBottomFade: boolean;
    showTopFade: boolean;
    viewportMaxHeightPx: number;
    viewportOffsetTopPx: number;
    visible: boolean;
}>;

export type DeriveTranscriptNavigationRailLayoutInput = Readonly<{
    entryCount: number;
    gutterSpacingPx?: number;
    markerHeightPx?: number;
    markerSpacingPx?: number;
    minPaneWidthPx?: number;
    paneHeightPx: number;
    paneWidthPx: number;
    platformOS: TranscriptNavigationRailPlatformOS;
    railWidthPx?: number;
    scrollTopPx?: number;
    transcriptContentWidthPx: number;
    transcriptMaxWidthPx?: number;
    viewportHeightRatio?: number;
}>;

const DEFAULT_MIN_PANE_WIDTH_PX = 864;
const DEFAULT_RAIL_WIDTH_PX = 24;
const DEFAULT_GUTTER_SPACING_PX = 8;
const DEFAULT_MARKER_HEIGHT_PX = 4;
const DEFAULT_MARKER_SPACING_PX = 8;
const DEFAULT_VIEWPORT_HEIGHT_RATIO = 0.8;
const FADE_EPSILON_PX = 1;

function finitePositive(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function finiteNonNegative(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function computeContentHeight(entryCount: number, markerHeightPx: number, markerSpacingPx: number): number {
    if (!Number.isInteger(entryCount) || entryCount <= 0) return 0;
    return (entryCount * markerHeightPx) + (Math.max(0, entryCount - 1) * markerSpacingPx);
}

export function deriveTranscriptNavigationRailLayout(
    input: DeriveTranscriptNavigationRailLayoutInput,
): TranscriptNavigationRailLayout {
    const entryCount = Number.isInteger(input.entryCount) ? Math.max(0, input.entryCount) : 0;
    const railWidthPx = finitePositive(input.railWidthPx, DEFAULT_RAIL_WIDTH_PX);
    const gutterSpacingPx = finiteNonNegative(input.gutterSpacingPx, DEFAULT_GUTTER_SPACING_PX);
    const markerHeightPx = finitePositive(input.markerHeightPx, DEFAULT_MARKER_HEIGHT_PX);
    const markerSpacingPx = finiteNonNegative(input.markerSpacingPx, DEFAULT_MARKER_SPACING_PX);
    const paneHeightPx = finitePositive(input.paneHeightPx, 0);
    const paneWidthPx = finitePositive(input.paneWidthPx, 0);
    const minPaneWidthPx = finitePositive(input.minPaneWidthPx, DEFAULT_MIN_PANE_WIDTH_PX);
    const viewportHeightRatio = Math.min(1, finitePositive(input.viewportHeightRatio, DEFAULT_VIEWPORT_HEIGHT_RATIO));
    const transcriptContentWidthPx = finitePositive(input.transcriptContentWidthPx, 0);
    const transcriptMaxWidthPx = finitePositive(input.transcriptMaxWidthPx, transcriptContentWidthPx);
    const effectiveTranscriptWidthPx = Math.min(transcriptContentWidthPx, transcriptMaxWidthPx);
    const contentHeightPx = computeContentHeight(entryCount, markerHeightPx, markerSpacingPx);
    const viewportMaxHeightPx = Math.max(0, Math.floor(paneHeightPx * viewportHeightRatio));
    const viewportOffsetTopPx = Math.max(0, Math.floor((paneHeightPx - viewportMaxHeightPx) / 2));
    const maxScrollTopPx = Math.max(0, contentHeightPx - viewportMaxHeightPx);
    const scrollTopPx = Math.min(maxScrollTopPx, finiteNonNegative(input.scrollTopPx, 0));
    const overflow = contentHeightPx > viewportMaxHeightPx;
    const base = {
        contentHeightPx,
        markerHeightPx,
        markerSpacingPx,
        overflow,
        railWidthPx,
        scrollTopPx,
        showBottomFade: overflow && scrollTopPx < maxScrollTopPx - FADE_EPSILON_PX,
        showTopFade: overflow && scrollTopPx > FADE_EPSILON_PX,
        viewportMaxHeightPx,
        viewportOffsetTopPx,
    } as const;

    if (input.platformOS !== 'web') {
        return { ...base, hiddenReason: 'native-platform', visible: false };
    }
    if (entryCount < 2) {
        return { ...base, hiddenReason: 'too-few-entries', visible: false };
    }
    if (paneWidthPx < minPaneWidthPx) {
        return { ...base, hiddenReason: 'below-width-threshold', visible: false };
    }
    const sideGutterPx = Math.max(0, (paneWidthPx - effectiveTranscriptWidthPx) / 2);
    if (sideGutterPx < railWidthPx + gutterSpacingPx) {
        return { ...base, hiddenReason: 'insufficient-gutter', visible: false };
    }
    return { ...base, hiddenReason: null, visible: true };
}
