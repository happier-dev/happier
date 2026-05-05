export type TranscriptBottomScrollDirection = 'toward-zero' | 'toward-max';

export type TranscriptBottomFollowIntentResult = Readonly<{
    effectivePinnedOffsetThresholdPx: number;
    isPinned: boolean;
    nextDistanceFromBottom: number;
    nextScrollOffset: number;
    rearmed: boolean;
    released: boolean;
    wantsPinned: boolean;
}>;

export function resolveTranscriptBottomFollowIntent(params: Readonly<{
    direction: TranscriptBottomScrollDirection;
    distanceFromBottom: number;
    pinThresholdPx: number;
    previousScrollOffset: number | null;
    recentUserIntent: boolean;
    scrollOffset: number;
    wantsPinned: boolean;
}>): TranscriptBottomFollowIntentResult {
    const distanceFromBottom = normalizeFiniteNonNegative(params.distanceFromBottom);
    const scrollOffset = normalizeFiniteNonNegative(params.scrollOffset);
    const pinThresholdPx = normalizeFiniteNonNegative(params.pinThresholdPx);
    const previousScrollOffset =
        typeof params.previousScrollOffset === 'number' && Number.isFinite(params.previousScrollOffset)
            ? Math.max(0, params.previousScrollOffset)
            : null;

    const movedAwayFromBottom =
        previousScrollOffset === null
            ? false
            : params.direction === 'toward-zero'
                ? scrollOffset > previousScrollOffset
                : scrollOffset < previousScrollOffset;
    const movedTowardBottom =
        previousScrollOffset === null
            ? false
            : params.direction === 'toward-zero'
                ? scrollOffset < previousScrollOffset
                : scrollOffset > previousScrollOffset;

    let wantsPinned = params.wantsPinned;
    let rearmed = false;
    let released = false;

    if (distanceFromBottom === 0) {
        rearmed = wantsPinned !== true;
        wantsPinned = true;
    } else if (params.recentUserIntent && movedAwayFromBottom) {
        released = wantsPinned !== false;
        wantsPinned = false;
    } else if (params.recentUserIntent && movedTowardBottom && distanceFromBottom <= pinThresholdPx) {
        rearmed = wantsPinned !== true;
        wantsPinned = true;
    }

    const effectivePinnedOffsetThresholdPx = wantsPinned ? pinThresholdPx : 0;

    return {
        effectivePinnedOffsetThresholdPx,
        isPinned: distanceFromBottom <= effectivePinnedOffsetThresholdPx,
        nextDistanceFromBottom: distanceFromBottom,
        nextScrollOffset: scrollOffset,
        rearmed,
        released,
        wantsPinned,
    };
}

function normalizeFiniteNonNegative(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.trunc(value));
}
