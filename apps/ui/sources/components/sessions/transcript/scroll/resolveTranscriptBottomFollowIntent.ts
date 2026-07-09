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

/**
 * Per-frame bottom-follow intent derivation.
 *
 * `canRelease` is the trusted-gate (plan B6): only observations carrying release
 * authority (trusted user scrolls on native — including untrusted momentum frames
 * inside the post-drag attribution window, plan B9; genuine gesture-derived intent
 * on web) may transition `wantsPinned` true -> false. Untrusted height-churn
 * observations can never unpin a user who did not scroll.
 */
export function resolveTranscriptBottomFollowIntent(params: Readonly<{
    canRearmBottom?: boolean;
    canRelease: boolean;
    direction: TranscriptBottomScrollDirection;
    distanceFromBottom: number;
    pinThresholdPx: number;
    previousScrollOffset: number | null;
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

    if (distanceFromBottom === 0 && params.canRearmBottom !== false) {
        rearmed = wantsPinned !== true;
        wantsPinned = true;
    } else if (params.canRelease && movedAwayFromBottom) {
        released = wantsPinned !== false;
        wantsPinned = false;
    } else if (params.canRearmBottom !== false && movedTowardBottom && distanceFromBottom <= pinThresholdPx) {
        rearmed = wantsPinned !== true;
        wantsPinned = true;
    }

    const effectivePinnedOffsetThresholdPx = wantsPinned ? pinThresholdPx : 0;

    return {
        effectivePinnedOffsetThresholdPx,
        isPinned: wantsPinned && distanceFromBottom <= effectivePinnedOffsetThresholdPx,
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
