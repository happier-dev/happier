export type NativeBottomFollowCompletionEffect = Readonly<{
    entrySettleBaselineContentHeight: number;
    sessionId: string;
    type: 'complete-native-bottom-follow';
}>;

export function resolveNativeBottomFollowCompletionEffects(params: Readonly<{
    contentHeight: number;
    distanceFromBottom: number;
    isNative: boolean;
    pinThresholdPx: number;
    sessionId: string;
    wantsPinned: boolean;
}>): readonly NativeBottomFollowCompletionEffect[] {
    if (
        !params.isNative ||
        !params.wantsPinned ||
        params.distanceFromBottom > params.pinThresholdPx
    ) {
        return [];
    }
    return [{
        entrySettleBaselineContentHeight: params.contentHeight,
        sessionId: params.sessionId,
        type: 'complete-native-bottom-follow',
    }];
}
