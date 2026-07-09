export type NativeScrollFollowIntentReleaseBlockedReason =
    | 'missing-release-authority'
    | 'inside-inverted-pin-threshold';

export type NativeScrollFollowIntentReleaseDecision =
    | Readonly<{ type: 'allow-release' }>
    | Readonly<{ reason: NativeScrollFollowIntentReleaseBlockedReason; type: 'block-release' }>;

export function resolveNativeScrollFollowIntentReleaseDecision(params: Readonly<{
    distanceFromLiveTailPx: number;
    hasTrustedDragSession: boolean;
    isTrusted: boolean;
    nativeMomentumScrollActive: boolean;
    pinThresholdPx: number;
}>): NativeScrollFollowIntentReleaseDecision {
    const hasReleaseAuthority =
        params.isTrusted ||
        (
            params.nativeMomentumScrollActive &&
            params.hasTrustedDragSession
        );
    if (!hasReleaseAuthority) {
        return { reason: 'missing-release-authority', type: 'block-release' };
    }
    if (params.distanceFromLiveTailPx <= params.pinThresholdPx) {
        return { reason: 'inside-inverted-pin-threshold', type: 'block-release' };
    }
    return { type: 'allow-release' };
}
