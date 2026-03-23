export function shouldPrefetchOlderFromTop(params: Readonly<{
    scrollable: boolean;
    offsetY: number;
    prefetchThresholdPx: number;
    distanceFromBottom: number;
    pinThresholdPx: number;
    wantsPinned: boolean;
}>): boolean {
    if (params.scrollable !== true) return false;
    if (!Number.isFinite(params.offsetY) || params.offsetY < 0) return false;
    if (!Number.isFinite(params.prefetchThresholdPx) || params.prefetchThresholdPx <= 0) return false;
    if (params.offsetY > params.prefetchThresholdPx) return false;
    if (
        Number.isFinite(params.distanceFromBottom) &&
        params.distanceFromBottom <= params.pinThresholdPx &&
        params.wantsPinned
    ) {
        return false;
    }
    return true;
}
