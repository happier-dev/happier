export type NativeScrollFollowIntentRearmDecision =
    | Readonly<{ type: 'allow-rearm' }>
    | Readonly<{
        reason: 'open-away-gesture-without-trusted-return';
        type: 'block-rearm';
    }>;

export function resolveNativeScrollFollowIntentRearmDecision(params: Readonly<{
    hasOpenTrustedAwayGesture: boolean;
    isTrusted: boolean;
    movedTowardLiveTail: boolean;
}>): NativeScrollFollowIntentRearmDecision {
    if (!params.hasOpenTrustedAwayGesture) return { type: 'allow-rearm' };
    if (params.isTrusted && params.movedTowardLiveTail) return { type: 'allow-rearm' };
    return {
        reason: 'open-away-gesture-without-trusted-return',
        type: 'block-rearm',
    };
}
