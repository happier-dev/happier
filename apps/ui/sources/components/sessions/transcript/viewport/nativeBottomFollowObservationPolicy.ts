function isFiniteNumber(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

export function nativeBottomFollowPinTargetObserved(params: Readonly<{
    lastNativePinOffset: number | null | undefined;
    pinThresholdPx: number;
    visualBottomScrollOffset: number | null | undefined;
}>): boolean {
    if (!isFiniteNumber(params.lastNativePinOffset) || !isFiniteNumber(params.visualBottomScrollOffset)) {
        return false;
    }
    return (
        Math.abs(params.visualBottomScrollOffset - params.lastNativePinOffset) <= params.pinThresholdPx ||
        params.lastNativePinOffset >= params.visualBottomScrollOffset - params.pinThresholdPx
    );
}

export function nativeBottomFollowCanCompletePendingPin(params: Readonly<{
    mountSettleDeadlineReached: boolean;
    mountSettleStable: boolean;
    pendingBottomPin: boolean;
    pinTargetObserved: boolean;
}>): boolean {
    return (
        params.mountSettleStable ||
        params.mountSettleDeadlineReached ||
        !params.pendingBottomPin ||
        params.pinTargetObserved
    );
}

export function nativeBottomFollowCanApplyCompletion(params: Readonly<{
    canCompletePendingPin: boolean;
    distanceFromBottom: number;
    isNative: boolean;
    pinThresholdPx: number;
    wantsPinned: boolean;
}>): boolean {
    return (
        params.isNative &&
        params.wantsPinned &&
        params.distanceFromBottom <= params.pinThresholdPx &&
        params.canCompletePendingPin
    );
}
