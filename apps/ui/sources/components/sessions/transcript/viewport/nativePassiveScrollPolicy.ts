export type NativePassiveBottomDriftNoiseFloorRequest = Readonly<{
    configuredBottomDistanceNoiseFloorPx: number | null | undefined;
    pinThresholdPx: number;
}>;

export type NativeInvalidScrollObservationRequest = Readonly<{
    distanceFromBottom: number;
    isWeb: boolean;
    offsetY: number;
}>;

export type NativePassiveUnpinnedMovementRequest = Readonly<{
    configuredBottomDistanceNoiseFloorPx: number | null | undefined;
    distanceFromBottom: number;
    hasNativeContentMeasurement: boolean;
    hasNativeInitialViewportApplied: boolean;
    isWeb: boolean;
    pinThresholdPx: number;
    wantsPinned: boolean;
}>;

export type NativePassiveViewportScrollRequest = Readonly<{
    configuredBottomDistanceNoiseFloorPx: number | null | undefined;
    currentSessionId: string;
    distanceFromBottom: number;
    entryViewportSessionId: string | null;
    entryViewportShouldFollowBottom: boolean | null;
    hasNativeContentMeasurement: boolean;
    hasNativeInitialViewportApplied: boolean;
    isTrusted: boolean;
    isWeb: boolean;
    lastUserScrollIntentAtMs: number;
    nowMs: number;
    pinThresholdPx: number;
    shouldRecordPassiveUnpinnedMovement: boolean;
    userIntentRecentMs: number;
    wantsPinned: boolean;
}>;

export function resolveNativePassiveBottomDriftNoiseFloorPx(
    request: NativePassiveBottomDriftNoiseFloorRequest,
): number {
    const configured = request.configuredBottomDistanceNoiseFloorPx;
    const normalizedConfigured = typeof configured === 'number' && Number.isFinite(configured)
        ? Math.max(0, Math.trunc(configured))
        : 0;
    const normalizedThreshold = typeof request.pinThresholdPx === 'number' && Number.isFinite(request.pinThresholdPx)
        ? Math.max(0, Math.trunc(request.pinThresholdPx))
        : 0;
    return Math.min(normalizedThreshold, normalizedConfigured);
}

export function shouldIgnoreNativeInvalidScrollObservation(request: NativeInvalidScrollObservationRequest): boolean {
    if (request.isWeb) return false;
    if (!Number.isFinite(request.offsetY)) return true;
    if (!Number.isFinite(request.distanceFromBottom)) return true;
    return request.offsetY < 0;
}

export function shouldRecordNativePassiveUnpinnedMovement(request: NativePassiveUnpinnedMovementRequest): boolean {
    if (request.isWeb) return false;
    if (request.wantsPinned) return false;
    if (!request.hasNativeContentMeasurement) return false;
    if (!request.hasNativeInitialViewportApplied) return false;
    return request.distanceFromBottom > resolveNativePassiveBottomDriftNoiseFloorPx({
        configuredBottomDistanceNoiseFloorPx: request.configuredBottomDistanceNoiseFloorPx,
        pinThresholdPx: request.pinThresholdPx,
    });
}

export function shouldIgnoreNativePassiveViewportScroll(request: NativePassiveViewportScrollRequest): boolean {
    if (request.isWeb || request.isTrusted) return false;
    if (!request.hasNativeContentMeasurement) return true;
    if (request.nowMs - request.lastUserScrollIntentAtMs < request.userIntentRecentMs) {
        return false;
    }
    if (!request.wantsPinned) {
        if (
            request.distanceFromBottom <= resolveNativePassiveBottomDriftNoiseFloorPx({
                configuredBottomDistanceNoiseFloorPx: request.configuredBottomDistanceNoiseFloorPx,
                pinThresholdPx: request.pinThresholdPx,
            })
        ) {
            return true;
        }
        if (
            request.entryViewportSessionId === request.currentSessionId &&
            request.entryViewportShouldFollowBottom === false &&
            !request.hasNativeInitialViewportApplied
        ) {
            return true;
        }
        return !request.shouldRecordPassiveUnpinnedMovement;
    }
    return false;
}
