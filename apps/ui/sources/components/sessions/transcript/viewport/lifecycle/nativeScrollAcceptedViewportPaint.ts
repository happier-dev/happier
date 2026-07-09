export type NativeScrollAcceptedViewportPaintDecision =
    | Readonly<{ type: 'record-accepted-viewport-paint' }>
    | Readonly<{
        reason:
            | 'not-native'
            | 'not-loaded'
            | 'empty-list'
            | 'trusted-observation'
            | 'not-accepted';
        type: 'skip';
    }>;

export type NativeScrollAcceptedViewportPaintEffect = Readonly<{
    fallbackMetrics: Readonly<{
        contentHeight: number;
        distanceFromLiveTailPx: number;
        layoutHeight: number;
    }>;
    sessionId: string;
    type: 'record-accepted-viewport-paint';
}>;

export function resolveNativeFollowBottomObservationCanReleasePaint(params: Readonly<{
    distanceFromLiveTailPx: number;
    isWarmKeepAliveInstance: boolean;
    nativeMountSettleDeadlineReached: boolean;
    nativeMountSettleStable: boolean;
    sessionEntryShouldFollowBottom: boolean | null | undefined;
    thresholdPx: number;
    usesNativeFlashListBottomMaintenance: boolean;
}>): boolean {
    if (params.distanceFromLiveTailPx > params.thresholdPx) return false;
    if (!params.usesNativeFlashListBottomMaintenance) return true;
    if (params.nativeMountSettleStable) return true;
    if (params.nativeMountSettleDeadlineReached) return true;
    return params.isWarmKeepAliveInstance && params.sessionEntryShouldFollowBottom !== false;
}

export function resolveNativeScrollAcceptedViewportPaintDecision(params: Readonly<{
    entryRestoreConfirmedByObservation: boolean;
    hasRenderedItems: boolean;
    isLoaded: boolean;
    isNative: boolean;
    isTrusted: boolean;
    nativeFollowBottomObservationCanReleasePaint: boolean;
    refDistanceFromLiveTailPx: number;
    thresholdPx: number;
    wantsPinned: boolean;
}>): NativeScrollAcceptedViewportPaintDecision {
    if (!params.isNative) return { reason: 'not-native', type: 'skip' };
    if (!params.isLoaded) return { reason: 'not-loaded', type: 'skip' };
    if (!params.hasRenderedItems) return { reason: 'empty-list', type: 'skip' };
    if (params.isTrusted) return { reason: 'trusted-observation', type: 'skip' };

    if (
        params.nativeFollowBottomObservationCanReleasePaint ||
        params.entryRestoreConfirmedByObservation ||
        (!params.wantsPinned && params.refDistanceFromLiveTailPx > params.thresholdPx)
    ) {
        return { type: 'record-accepted-viewport-paint' };
    }

    return { reason: 'not-accepted', type: 'skip' };
}

export function resolveNativeScrollAcceptedViewportPaintEffects(params: Readonly<{
    decision: NativeScrollAcceptedViewportPaintDecision;
    fallbackMetrics: Readonly<{
        contentHeight: number;
        distanceFromLiveTailPx: number;
        layoutHeight: number;
    }>;
    sessionId: string;
}>): readonly NativeScrollAcceptedViewportPaintEffect[] {
    if (params.decision.type !== 'record-accepted-viewport-paint') return [];

    return [{
        fallbackMetrics: {
            contentHeight: Math.max(0, Math.trunc(params.fallbackMetrics.contentHeight)),
            distanceFromLiveTailPx: Math.max(0, Math.trunc(params.fallbackMetrics.distanceFromLiveTailPx)),
            layoutHeight: Math.max(0, Math.trunc(params.fallbackMetrics.layoutHeight)),
        },
        sessionId: params.sessionId,
        type: 'record-accepted-viewport-paint',
    }];
}

export function resolveNativeScrollAcceptedViewportPaintObservationEffects(params: Readonly<{
    distanceFromLiveTailPx: number;
    entryRestoreConfirmedByObservation: boolean;
    fallbackMetrics: Readonly<{
        contentHeight: number;
        distanceFromLiveTailPx: number;
        layoutHeight: number;
    }>;
    hasRenderedItems: boolean;
    isLoaded: boolean;
    isNative: boolean;
    isTrusted: boolean;
    isWarmKeepAliveInstance: boolean;
    nativeMountSettleDeadlineReached: boolean;
    nativeMountSettleStable: boolean;
    sessionId: string;
    sessionEntryShouldFollowBottom: boolean | null | undefined;
    thresholdPx: number;
    usesNativeFlashListBottomMaintenance: boolean;
    wantsPinned: boolean;
}>): readonly NativeScrollAcceptedViewportPaintEffect[] {
    const nativeFollowBottomObservationCanReleasePaint = resolveNativeFollowBottomObservationCanReleasePaint({
        distanceFromLiveTailPx: params.distanceFromLiveTailPx,
        isWarmKeepAliveInstance: params.isWarmKeepAliveInstance,
        nativeMountSettleDeadlineReached: params.nativeMountSettleDeadlineReached,
        nativeMountSettleStable: params.nativeMountSettleStable,
        sessionEntryShouldFollowBottom: params.sessionEntryShouldFollowBottom,
        thresholdPx: params.thresholdPx,
        usesNativeFlashListBottomMaintenance: params.usesNativeFlashListBottomMaintenance,
    });

    return resolveNativeScrollAcceptedViewportPaintEffects({
        decision: resolveNativeScrollAcceptedViewportPaintDecision({
            entryRestoreConfirmedByObservation: params.entryRestoreConfirmedByObservation,
            hasRenderedItems: params.hasRenderedItems,
            isLoaded: params.isLoaded,
            isNative: params.isNative,
            isTrusted: params.isTrusted,
            nativeFollowBottomObservationCanReleasePaint,
            refDistanceFromLiveTailPx: params.distanceFromLiveTailPx,
            thresholdPx: params.thresholdPx,
            wantsPinned: params.wantsPinned,
        }),
        fallbackMetrics: params.fallbackMetrics,
        sessionId: params.sessionId,
    });
}
