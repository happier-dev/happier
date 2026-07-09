import { describe, expect, it } from 'vitest';

import { createTranscriptViewportLifecycle } from './lifecycle';
import {
    resolveWebScrollFactsObservationEvent,
    resolveWebScrollFactsObservationEffects,
} from './webScrollFactsObservation';

describe('web scroll facts observation event', () => {
    it('dispatches web genuine away movement with release authority', () => {
        expect(resolveWebScrollFactsObservationEvent({
            distanceFromLiveTailPx: 180.9,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: true,
            pinThresholdPx: 72.6,
            sessionId: 'session-a',
            webObservedUserScrollMovement: true,
        })).toEqual({
            distanceFromLiveTailPx: 180,
            movement: 'away-from-live-tail',
            pinThresholdPx: 72,
            releaseAuthority: 'web-genuine-movement',
            sessionId: 'session-a',
            source: 'web-scroll',
            trustedUserMovement: false,
            type: 'facts-observed',
        });
    });

    it('dispatches web toward movement without release authority', () => {
        expect(resolveWebScrollFactsObservationEvent({
            distanceFromLiveTailPx: 12,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            webObservedUserScrollMovement: false,
        })).toEqual({
            distanceFromLiveTailPx: 12,
            movement: 'toward-live-tail',
            pinThresholdPx: 72,
            sessionId: 'session-a',
            source: 'web-scroll',
            trustedUserMovement: false,
            type: 'facts-observed',
        });
    });

    it('dispatches web no-movement facts with normalized non-negative distance', () => {
        expect(resolveWebScrollFactsObservationEvent({
            distanceFromLiveTailPx: -4,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            webObservedUserScrollMovement: false,
        })).toEqual({
            distanceFromLiveTailPx: 0,
            movement: 'none',
            pinThresholdPx: 72,
            sessionId: 'session-a',
            source: 'web-scroll',
            trustedUserMovement: false,
            type: 'facts-observed',
        });
    });
});

describe('web scroll facts observation effects', () => {
    it('emits web release effects for genuine upward movement', () => {
        const lifecycle = createTranscriptViewportLifecycle();
        lifecycle.dispatch({
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
            type: 'session-entry',
        });

        expect(resolveWebScrollFactsObservationEffects({
            dispatch: lifecycle.dispatch,
            distanceFromLiveTailPx: 180,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            webObservedUserScrollMovement: true,
        })).toEqual([
            {
                distanceFromLiveTailPx: 180,
                isPinned: false,
                sessionId: 'session-a',
                type: 'web-release-live-tail',
            },
        ]);
    });

    it('emits observed-state effects for passive web content churn', () => {
        const lifecycle = createTranscriptViewportLifecycle();
        lifecycle.dispatch({
            sessionId: 'session-a',
            shouldFollowLiveTail: true,
            type: 'session-entry',
        });

        expect(resolveWebScrollFactsObservationEffects({
            dispatch: lifecycle.dispatch,
            distanceFromLiveTailPx: 180,
            movedAwayFromLiveTail: true,
            movedTowardLiveTail: false,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            webObservedUserScrollMovement: false,
        })).toEqual([
            {
                distanceFromLiveTailPx: 180,
                isPinned: false,
                pinnedOffsetThresholdPx: 72,
                sessionId: 'session-a',
                shouldRestoreViewport: false,
                type: 'web-observed-viewport-state',
                wantsPinned: true,
            },
        ]);
    });

    it('emits return-to-live-tail effects when a released web reader reaches the tail', () => {
        const lifecycle = createTranscriptViewportLifecycle();
        lifecycle.dispatch({
            sessionId: 'session-a',
            shouldFollowLiveTail: false,
            type: 'session-entry',
        });

        expect(resolveWebScrollFactsObservationEffects({
            dispatch: lifecycle.dispatch,
            distanceFromLiveTailPx: 12,
            movedAwayFromLiveTail: false,
            movedTowardLiveTail: true,
            pinThresholdPx: 72,
            sessionId: 'session-a',
            webObservedUserScrollMovement: false,
        })).toEqual([
            {
                distanceFromLiveTailPx: 12,
                isPinned: true,
                sessionId: 'session-a',
                source: 'mode-following',
                type: 'viewport-change',
            },
            {
                distanceFromLiveTailPx: 12,
                isPinned: true,
                sessionId: 'session-a',
                type: 'drain-deferred-newer',
            },
        ]);
    });
});
