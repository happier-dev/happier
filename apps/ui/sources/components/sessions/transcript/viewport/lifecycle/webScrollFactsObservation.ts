import type {
    TranscriptViewportLifecycleEffect,
    TranscriptViewportLifecycleEvent,
    TranscriptViewportLifecycleTransition,
} from './lifecycle';

type WebScrollFactsObservedEvent = Extract<
    TranscriptViewportLifecycleEvent,
    { type: 'facts-observed' }
> & Readonly<{ source: 'web-scroll' }>;

type WebScrollFactsObservationDispatch = (
    event: WebScrollFactsObservedEvent
) => TranscriptViewportLifecycleTransition;

export function resolveWebScrollFactsObservationEvent(params: Readonly<{
    distanceFromLiveTailPx: number;
    movedAwayFromLiveTail: boolean;
    movedTowardLiveTail: boolean;
    pinThresholdPx: number;
    sessionId: string;
    webObservedUserScrollMovement: boolean;
}>): WebScrollFactsObservedEvent {
    const distanceFromLiveTailPx = Math.max(0, Math.trunc(params.distanceFromLiveTailPx));
    const pinThresholdPx = Math.max(0, Math.trunc(params.pinThresholdPx));
    return {
        distanceFromLiveTailPx,
        movement: params.movedAwayFromLiveTail
            ? 'away-from-live-tail'
            : params.movedTowardLiveTail
                ? 'toward-live-tail'
                : 'none',
        pinThresholdPx,
        ...(params.webObservedUserScrollMovement ? { releaseAuthority: 'web-genuine-movement' as const } : {}),
        sessionId: params.sessionId,
        source: 'web-scroll',
        trustedUserMovement: false,
        type: 'facts-observed',
    };
}

export function resolveWebScrollFactsObservationEffects(params: Readonly<{
    dispatch: WebScrollFactsObservationDispatch;
    distanceFromLiveTailPx: number;
    movedAwayFromLiveTail: boolean;
    movedTowardLiveTail: boolean;
    pinThresholdPx: number;
    sessionId: string;
    webObservedUserScrollMovement: boolean;
}>): readonly TranscriptViewportLifecycleEffect[] {
    return params.dispatch(resolveWebScrollFactsObservationEvent({
        distanceFromLiveTailPx: params.distanceFromLiveTailPx,
        movedAwayFromLiveTail: params.movedAwayFromLiveTail,
        movedTowardLiveTail: params.movedTowardLiveTail,
        pinThresholdPx: params.pinThresholdPx,
        sessionId: params.sessionId,
        webObservedUserScrollMovement: params.webObservedUserScrollMovement,
    })).effects;
}
