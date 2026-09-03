export type GenericScrollObservationViewportState = Readonly<{
    anchorCapture: Readonly<{
        suppressAnchorCapture: boolean;
        viewportState: Readonly<{
            isPinned: boolean;
            offsetY: number;
            shouldRestoreViewport: boolean;
            shouldPersistViewport: false;
        }>;
    }>;
    drain: Readonly<{
        distanceFromLiveTailPx: number;
        isPinned: boolean;
    }>;
    jumpButtonDistanceFromLiveTailPx: number;
    lastDistanceFromLiveTailPx: number;
    nextScrollOffsetPx: number;
    scrollPinEvent: Readonly<{
        enabled: boolean;
        offsetY: number;
        pinnedOffsetThresholdPx: number;
        type: 'scroll';
    }>;
    viewportState: Readonly<{
        isPinned: boolean;
        offsetY: number;
        shouldRestoreViewport: boolean;
        shouldPersistViewport: false;
    }>;
    wantsPinned: boolean;
}>;

export type GenericScrollObservationViewportStateEffect = Readonly<{
    sessionId: string;
    state: GenericScrollObservationViewportState;
    type: 'apply-generic-observed-viewport-state';
}>;

export type GenericScrollObservationReadOnlyVisibleBottomState = Readonly<{
    jumpButtonDistanceFromLiveTailPx: number;
    lastDistanceFromLiveTailPx: number;
    scrollPinEvent: Readonly<{
        enabled: boolean;
        offsetY: number;
        pinnedOffsetThresholdPx: number;
        type: 'scroll';
    }>;
}>;

export type GenericScrollObservationReadOnlyVisibleBottomEffect = Readonly<{
    sessionId: string;
    state: GenericScrollObservationReadOnlyVisibleBottomState;
    type: 'apply-generic-read-only-visible-bottom-state';
}>;

export type GenericScrollObservationSuppressionReason = 'native-passive-drift';

export type GenericScrollObservationSuppressionEffect = Readonly<{
    reason: GenericScrollObservationSuppressionReason;
    sessionId: string;
    type: 'suppress-generic-scroll-observation';
}>;

export type GenericScrollObservationAnchorCaptureCancellationReason =
    | 'native-passive-untrusted'
    | 'web-no-live-metrics-fallback-release';

export type GenericScrollObservationAnchorCaptureCancellationEffect = Readonly<{
    reason: GenericScrollObservationAnchorCaptureCancellationReason;
    sessionId: string;
    type: 'cancel-scheduled-viewport-anchor-capture';
}>;

export type GenericScrollObservationViewportStateParams = Readonly<{
    followIntentIsPinned: boolean;
    followIntentNextDistanceFromLiveTailPx: number;
    followIntentNextScrollOffsetPx: number;
    followIntentWantsPinned: boolean;
    pinEnabled: boolean;
    pinnedOffsetThresholdPx: number;
    suppressAnchorCapture: boolean;
    viewportDistanceFromLiveTailPx: number;
}>;

export type GenericScrollObservationReadOnlyVisibleBottomParams = Readonly<{
    distanceFromLiveTailPx: number;
    pinEnabled: boolean;
    pinnedOffsetThresholdPx: number;
}>;

export function resolveGenericScrollObservationViewportState(
    params: GenericScrollObservationViewportStateParams,
): GenericScrollObservationViewportState {
    const viewportState = {
        isPinned: params.followIntentIsPinned,
        offsetY: params.viewportDistanceFromLiveTailPx,
        shouldRestoreViewport: !params.followIntentWantsPinned,
        shouldPersistViewport: false as const,
    };
    return {
        anchorCapture: {
            suppressAnchorCapture: params.suppressAnchorCapture,
            viewportState,
        },
        drain: {
            distanceFromLiveTailPx: params.viewportDistanceFromLiveTailPx,
            isPinned: params.followIntentIsPinned,
        },
        jumpButtonDistanceFromLiveTailPx: params.viewportDistanceFromLiveTailPx,
        lastDistanceFromLiveTailPx: params.followIntentNextDistanceFromLiveTailPx,
        nextScrollOffsetPx: params.followIntentNextScrollOffsetPx,
        scrollPinEvent: {
            enabled: params.pinEnabled,
            offsetY: params.viewportDistanceFromLiveTailPx,
            pinnedOffsetThresholdPx: params.pinnedOffsetThresholdPx,
            type: 'scroll',
        },
        viewportState,
        wantsPinned: params.followIntentWantsPinned,
    };
}

export function resolveGenericScrollObservationViewportStateEffects(
    params: GenericScrollObservationViewportStateParams & Readonly<{ sessionId: string }>,
): readonly GenericScrollObservationViewportStateEffect[] {
    return [
        {
            sessionId: params.sessionId,
            state: resolveGenericScrollObservationViewportState(params),
            type: 'apply-generic-observed-viewport-state',
        },
    ];
}

export function resolveGenericScrollObservationAnchorCaptureCancellationEffects(params: Readonly<{
    reason: GenericScrollObservationAnchorCaptureCancellationReason;
    sessionId: string;
}>): readonly GenericScrollObservationAnchorCaptureCancellationEffect[] {
    return [{
        reason: params.reason,
        sessionId: params.sessionId,
        type: 'cancel-scheduled-viewport-anchor-capture',
    }];
}

export function resolveGenericScrollObservationViewportStateApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly GenericScrollObservationViewportStateEffect[] {
    return params.effects.filter((
        effect,
    ): effect is GenericScrollObservationViewportStateEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'apply-generic-observed-viewport-state'
    ));
}

export function resolveGenericScrollObservationAnchorCaptureCancellationApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly GenericScrollObservationAnchorCaptureCancellationEffect[] {
    return params.effects.filter((
        effect,
    ): effect is GenericScrollObservationAnchorCaptureCancellationEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'cancel-scheduled-viewport-anchor-capture'
    ));
}

export function resolveGenericScrollObservationReadOnlyVisibleBottomState(
    params: GenericScrollObservationReadOnlyVisibleBottomParams,
): GenericScrollObservationReadOnlyVisibleBottomState {
    return {
        jumpButtonDistanceFromLiveTailPx: params.distanceFromLiveTailPx,
        lastDistanceFromLiveTailPx: params.distanceFromLiveTailPx,
        scrollPinEvent: {
            enabled: params.pinEnabled,
            offsetY: params.distanceFromLiveTailPx,
            pinnedOffsetThresholdPx: params.pinnedOffsetThresholdPx,
            type: 'scroll',
        },
    };
}

export function resolveGenericScrollObservationReadOnlyVisibleBottomEffects(
    params: GenericScrollObservationReadOnlyVisibleBottomParams & Readonly<{ sessionId: string }>,
): readonly GenericScrollObservationReadOnlyVisibleBottomEffect[] {
    return [
        {
            sessionId: params.sessionId,
            state: resolveGenericScrollObservationReadOnlyVisibleBottomState(params),
            type: 'apply-generic-read-only-visible-bottom-state',
        },
    ];
}

export function resolveGenericScrollObservationReadOnlyVisibleBottomStateEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly GenericScrollObservationReadOnlyVisibleBottomEffect[] {
    return params.effects.filter((
        effect,
    ): effect is GenericScrollObservationReadOnlyVisibleBottomEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'apply-generic-read-only-visible-bottom-state'
    ));
}

export function resolveGenericScrollObservationSuppressionEffects(params: Readonly<{
    reason: GenericScrollObservationSuppressionReason;
    sessionId: string;
}>): readonly GenericScrollObservationSuppressionEffect[] {
    return [{
        reason: params.reason,
        sessionId: params.sessionId,
        type: 'suppress-generic-scroll-observation',
    }];
}

export function resolveGenericScrollObservationSuppressionApplyEffects(params: Readonly<{
    effects: readonly Readonly<{ sessionId?: string; type: string }>[];
    sessionId: string;
}>): readonly GenericScrollObservationSuppressionEffect[] {
    return params.effects.filter((
        effect,
    ): effect is GenericScrollObservationSuppressionEffect => (
        effect.sessionId === params.sessionId &&
        effect.type === 'suppress-generic-scroll-observation'
    ));
}
