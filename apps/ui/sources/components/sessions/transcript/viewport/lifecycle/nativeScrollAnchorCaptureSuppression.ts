export function resolveNativeScrollObservationAnchorCaptureSuppression(params: Readonly<{
    nativeMomentumScrollActive: boolean;
    shouldSuppressNativeAnchorCapture: boolean;
    trustedDragSessionActive: boolean;
}>): boolean {
    return params.shouldSuppressNativeAnchorCapture && !(
        params.nativeMomentumScrollActive &&
        params.trustedDragSessionActive
    );
}
