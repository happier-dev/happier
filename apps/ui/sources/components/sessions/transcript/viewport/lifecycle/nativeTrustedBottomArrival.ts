export type NativeTrustedBottomArrivalViewportState = Readonly<{
    isPinned: true;
    offsetY: 0;
    shouldRestoreViewport: false;
}>;

export type NativeTrustedBottomArrivalEffect = Readonly<{
    distanceFromLiveTailPx: number;
    sessionId: string;
    type: 'adopt-native-trusted-bottom-arrival';
    viewportState: NativeTrustedBottomArrivalViewportState;
}>;

export function resolveNativeTrustedBottomArrivalEffects(params: Readonly<{
    distanceFromLiveTailPx: number | null;
    sessionId: string;
}>): readonly NativeTrustedBottomArrivalEffect[] {
    const distanceFromLiveTailPx = typeof params.distanceFromLiveTailPx === 'number' && Number.isFinite(params.distanceFromLiveTailPx)
        ? Math.max(0, Math.trunc(params.distanceFromLiveTailPx))
        : 0;

    return [{
        distanceFromLiveTailPx,
        sessionId: params.sessionId,
        type: 'adopt-native-trusted-bottom-arrival',
        viewportState: {
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: false,
        },
    }];
}
