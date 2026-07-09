import { describe, expect, it } from 'vitest';

import { createTranscriptViewportLifecycle } from './lifecycle';
import {
    resolveNativeScrollFactsObservationDecision,
    resolveNativeScrollFactsObservationEffects,
} from './nativeScrollFactsObservation';

describe('native scroll facts observation decision', () => {
    it('dispatches trusted away facts when moved away with recent user intent', () => {
        expect(resolveNativeScrollFactsObservationDecision({
            distanceFromLiveTailPx: 96,
            isTrusted: false,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            pinThresholdPx: 72,
            recentUserIntent: true,
        })).toEqual({
            movement: 'away-from-live-tail',
            trustedUserMovement: true,
            type: 'dispatch',
        });
    });

    it('dispatches trusted toward facts for trusted movement toward the live tail', () => {
        expect(resolveNativeScrollFactsObservationDecision({
            distanceFromLiveTailPx: 48,
            isTrusted: true,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: true,
            pinThresholdPx: 72,
            recentUserIntent: false,
        })).toEqual({
            movement: 'toward-live-tail',
            trustedUserMovement: true,
            type: 'dispatch',
        });
    });

    it('dispatches passive steady facts for untrusted near-bottom observations', () => {
        expect(resolveNativeScrollFactsObservationDecision({
            distanceFromLiveTailPx: 72,
            isTrusted: false,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: false,
            pinThresholdPx: 72,
            recentUserIntent: false,
        })).toEqual({
            movement: 'none',
            trustedUserMovement: false,
            type: 'dispatch',
        });
    });

    it('ignores untrusted away churn without recent user intent', () => {
        expect(resolveNativeScrollFactsObservationDecision({
            distanceFromLiveTailPx: 96,
            isTrusted: false,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            pinThresholdPx: 72,
            recentUserIntent: false,
        })).toEqual({
            reason: 'no-lifecycle-fact',
            type: 'ignore',
        });
    });

    it('returns no effects for ignored untrusted away churn without recent user intent', () => {
        const lifecycle = createTranscriptViewportLifecycle();

        expect(resolveNativeScrollFactsObservationEffects({
            dispatch: lifecycle.dispatch,
            distanceFromLiveTailPx: 96,
            isTrusted: false,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            pinThresholdPx: 72,
            recentUserIntent: false,
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('emits release effects for active native drag away facts', () => {
        const lifecycle = createTranscriptViewportLifecycle();
        lifecycle.dispatch({
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
            type: 'session-entry',
        });
        lifecycle.dispatch({ sessionId: 'session-a', type: 'gesture-start' });

        expect(resolveNativeScrollFactsObservationEffects({
            dispatch: lifecycle.dispatch,
            distanceFromLiveTailPx: 96,
            isTrusted: true,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            pinThresholdPx: 72,
            recentUserIntent: true,
            sessionId: 'session-a',
        })).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'native-scroll-release-live-tail' }),
        ]));
    });

    it('emits observed viewport-state effects for passive near-bottom native facts', () => {
        const lifecycle = createTranscriptViewportLifecycle();
        lifecycle.dispatch({
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
            type: 'session-entry',
        });

        expect(resolveNativeScrollFactsObservationEffects({
            dispatch: lifecycle.dispatch,
            distanceFromLiveTailPx: 24,
            isTrusted: false,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: false,
            pinThresholdPx: 72,
            recentUserIntent: false,
            sessionId: 'session-a',
        })).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'native-observed-viewport-state' }),
        ]));
    });
});
