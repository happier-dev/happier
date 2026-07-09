import type {
    TranscriptViewportLifecycleEffect,
    TranscriptViewportLifecycleEvent,
    TranscriptViewportLifecycleTransition,
} from './lifecycle';

type NativeScrollMovement = Extract<
    TranscriptViewportLifecycleEvent,
    { type: 'facts-observed' }
>['movement'];

type NativeScrollFactsObservedEvent = Extract<
    TranscriptViewportLifecycleEvent,
    { type: 'facts-observed' }
>;

type NativeScrollFactsObservationDispatch = (
    event: NativeScrollFactsObservedEvent
) => TranscriptViewportLifecycleTransition;

export type NativeScrollFactsObservationDecision =
    | Readonly<{
        movement: NativeScrollMovement;
        trustedUserMovement: boolean;
        type: 'dispatch';
    }>
    | Readonly<{
        reason: 'no-lifecycle-fact';
        type: 'ignore';
    }>;

export function resolveNativeScrollFactsObservationDecision(params: Readonly<{
    distanceFromLiveTailPx: number;
    isTrusted: boolean;
    movedAwayFromLiveTail: boolean;
    movedTowardLiveTail: boolean;
    pinThresholdPx: number;
    recentUserIntent: boolean;
}>): NativeScrollFactsObservationDecision {
    if (params.movedAwayFromLiveTail && params.recentUserIntent) {
        return {
            movement: 'away-from-live-tail',
            trustedUserMovement: true,
            type: 'dispatch',
        };
    }
    if (params.isTrusted && params.movedTowardLiveTail) {
        return {
            movement: 'toward-live-tail',
            trustedUserMovement: true,
            type: 'dispatch',
        };
    }
    if (!params.isTrusted && params.distanceFromLiveTailPx <= params.pinThresholdPx) {
        return {
            movement: 'none',
            trustedUserMovement: false,
            type: 'dispatch',
        };
    }
    return {
        reason: 'no-lifecycle-fact',
        type: 'ignore',
    };
}

export function resolveNativeScrollFactsObservationEffects(params: Readonly<{
    dispatch: NativeScrollFactsObservationDispatch;
    distanceFromLiveTailPx: number;
    isTrusted: boolean;
    movedAwayFromLiveTail: boolean;
    movedTowardLiveTail: boolean;
    pinThresholdPx: number;
    recentUserIntent: boolean;
    sessionId: string;
}>): readonly TranscriptViewportLifecycleEffect[] {
    const decision = resolveNativeScrollFactsObservationDecision({
        distanceFromLiveTailPx: params.distanceFromLiveTailPx,
        isTrusted: params.isTrusted,
        movedAwayFromLiveTail: params.movedAwayFromLiveTail,
        movedTowardLiveTail: params.movedTowardLiveTail,
        pinThresholdPx: params.pinThresholdPx,
        recentUserIntent: params.recentUserIntent,
    });
    if (decision.type !== 'dispatch') return [];

    return params.dispatch({
        distanceFromLiveTailPx: params.distanceFromLiveTailPx,
        movement: decision.movement,
        pinThresholdPx: params.pinThresholdPx,
        sessionId: params.sessionId,
        source: 'native-scroll',
        trustedUserMovement: decision.trustedUserMovement,
        type: 'facts-observed',
    }).effects;
}
