import { describe, expect, it } from 'vitest';

import {
    resolveGenericScrollObservationSuppressionEffects,
    resolveGenericScrollObservationSuppressionApplyEffects,
    resolveGenericScrollObservationReadOnlyVisibleBottomEffects,
    resolveGenericScrollObservationReadOnlyVisibleBottomStateEffects,
    resolveGenericScrollObservationReadOnlyVisibleBottomState,
    resolveGenericScrollObservationViewportState,
    resolveGenericScrollObservationViewportStateApplyEffects,
    resolveGenericScrollObservationViewportStateEffects,
    type GenericScrollObservationReadOnlyVisibleBottomEffect,
    type GenericScrollObservationSuppressionEffect,
    type GenericScrollObservationViewportStateEffect,
} from './genericScrollObservationViewportState';

const observedViewportStateEffect = (
    overrides: Partial<GenericScrollObservationViewportStateEffect> = {},
): GenericScrollObservationViewportStateEffect => ({
    sessionId: 'session-a',
    state: resolveGenericScrollObservationViewportState({
        followIntentIsPinned: false,
        followIntentNextDistanceFromLiveTailPx: 12,
        followIntentNextScrollOffsetPx: 188,
        followIntentWantsPinned: false,
        pinEnabled: true,
        pinnedOffsetThresholdPx: 64,
        suppressAnchorCapture: true,
        viewportDistanceFromLiveTailPx: 12.8,
    }),
    type: 'apply-generic-observed-viewport-state',
    ...overrides,
});

const readOnlyVisibleBottomEffect = (
    overrides: Partial<GenericScrollObservationReadOnlyVisibleBottomEffect> = {},
): GenericScrollObservationReadOnlyVisibleBottomEffect => ({
    sessionId: 'session-a',
    state: resolveGenericScrollObservationReadOnlyVisibleBottomState({
        distanceFromLiveTailPx: 2.25,
        pinEnabled: true,
        pinnedOffsetThresholdPx: 64,
    }),
    type: 'apply-generic-read-only-visible-bottom-state',
    ...overrides,
});

const suppressionEffect = (
    overrides: Partial<GenericScrollObservationSuppressionEffect> = {},
): GenericScrollObservationSuppressionEffect => ({
    reason: 'native-passive-drift',
    sessionId: 'session-a',
    type: 'suppress-generic-scroll-observation',
    ...overrides,
});

describe('generic scroll observation viewport state', () => {
    it('packages unpinned generic observed viewport state', () => {
        expect(resolveGenericScrollObservationViewportState({
            followIntentIsPinned: false,
            followIntentNextDistanceFromLiveTailPx: 12,
            followIntentNextScrollOffsetPx: 188,
            followIntentWantsPinned: false,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 0,
            suppressAnchorCapture: true,
            viewportDistanceFromLiveTailPx: 12.8,
        })).toEqual({
            anchorCapture: {
                suppressAnchorCapture: true,
                viewportState: {
                    isPinned: false,
                    offsetY: 12.8,
                    shouldRestoreViewport: true,
                },
            },
            drain: {
                distanceFromLiveTailPx: 12.8,
                isPinned: false,
            },
            jumpButtonDistanceFromLiveTailPx: 12.8,
            lastDistanceFromLiveTailPx: 12,
            nextScrollOffsetPx: 188,
            scrollPinEvent: {
                enabled: true,
                offsetY: 12.8,
                pinnedOffsetThresholdPx: 0,
                type: 'scroll',
            },
            viewportState: {
                isPinned: false,
                offsetY: 12.8,
                shouldRestoreViewport: true,
            },
            wantsPinned: false,
        });
    });

    it('packages pinned live-tail observations', () => {
        const state = resolveGenericScrollObservationViewportState({
            followIntentIsPinned: true,
            followIntentNextDistanceFromLiveTailPx: 0,
            followIntentNextScrollOffsetPx: 0,
            followIntentWantsPinned: true,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
            suppressAnchorCapture: false,
            viewportDistanceFromLiveTailPx: 0,
        });

        expect(state.viewportState).toEqual({
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: false,
        });
        expect(state.scrollPinEvent).toEqual({
            enabled: true,
            offsetY: 0,
            pinnedOffsetThresholdPx: 72,
            type: 'scroll',
        });
        expect(state.drain).toEqual({
            distanceFromLiveTailPx: 0,
            isPinned: true,
        });
    });

    it('packages generic observed viewport state as an effect', () => {
        const stateParams = {
            followIntentIsPinned: false,
            followIntentNextDistanceFromLiveTailPx: 18,
            followIntentNextScrollOffsetPx: 220,
            followIntentWantsPinned: false,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 64,
            suppressAnchorCapture: true,
            viewportDistanceFromLiveTailPx: 24,
        };
        const effectParams = {
            ...stateParams,
            sessionId: 'session-a',
        };

        expect(resolveGenericScrollObservationViewportStateEffects(effectParams)).toEqual([
            {
                sessionId: 'session-a',
                state: resolveGenericScrollObservationViewportState(stateParams),
                type: 'apply-generic-observed-viewport-state',
            },
        ]);
    });

    it('packages read-only visible-bottom state without viewport persistence fields', () => {
        expect(resolveGenericScrollObservationReadOnlyVisibleBottomState({
            distanceFromLiveTailPx: 0,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 72,
        })).toEqual({
            jumpButtonDistanceFromLiveTailPx: 0,
            lastDistanceFromLiveTailPx: 0,
            scrollPinEvent: {
                enabled: true,
                offsetY: 0,
                pinnedOffsetThresholdPx: 72,
                type: 'scroll',
            },
        });
    });

    it('preserves fractional read-only visible-bottom distances', () => {
        expect(resolveGenericScrollObservationReadOnlyVisibleBottomState({
            distanceFromLiveTailPx: 3.5,
            pinEnabled: false,
            pinnedOffsetThresholdPx: 72,
        })).toEqual({
            jumpButtonDistanceFromLiveTailPx: 3.5,
            lastDistanceFromLiveTailPx: 3.5,
            scrollPinEvent: {
                enabled: false,
                offsetY: 3.5,
                pinnedOffsetThresholdPx: 72,
                type: 'scroll',
            },
        });
    });

    it('packages read-only visible-bottom state as a session-scoped generic effect', () => {
        const stateParams = {
            distanceFromLiveTailPx: 2.25,
            pinEnabled: true,
            pinnedOffsetThresholdPx: 64,
        };

        expect(resolveGenericScrollObservationReadOnlyVisibleBottomEffects({
            ...stateParams,
            sessionId: 'session-a',
        })).toEqual([{
            sessionId: 'session-a',
            state: resolveGenericScrollObservationReadOnlyVisibleBottomState(stateParams),
            type: 'apply-generic-read-only-visible-bottom-state',
        }]);
    });

    it('packages generic scroll-observation suppression as a session-scoped no-write effect', () => {
        expect(resolveGenericScrollObservationSuppressionEffects({
            reason: 'native-passive-drift',
            sessionId: 'session-a',
        })).toEqual([{
            reason: 'native-passive-drift',
            sessionId: 'session-a',
            type: 'suppress-generic-scroll-observation',
        }]);
    });

    it('returns no generic scroll-observation suppression apply effects when none match the current session', () => {
        expect(resolveGenericScrollObservationSuppressionApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveGenericScrollObservationSuppressionApplyEffects({
            effects: [suppressionEffect({ sessionId: 'session-b' })],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns current-session generic scroll-observation suppression apply effects', () => {
        const effect = suppressionEffect();

        expect(resolveGenericScrollObservationSuppressionApplyEffects({
            effects: [effect],
            sessionId: 'session-a',
        })).toEqual([effect]);
    });

    it('filters mixed effects down to current-session generic scroll-observation suppression apply effects', () => {
        const first = suppressionEffect();
        const second = suppressionEffect();

        expect(resolveGenericScrollObservationSuppressionApplyEffects({
            effects: [
                suppressionEffect({ sessionId: 'session-b' }),
                ...resolveGenericScrollObservationViewportStateEffects({
                    followIntentIsPinned: true,
                    followIntentNextDistanceFromLiveTailPx: 0,
                    followIntentNextScrollOffsetPx: 0,
                    followIntentWantsPinned: true,
                    pinEnabled: true,
                    pinnedOffsetThresholdPx: 72,
                    sessionId: 'session-a',
                    suppressAnchorCapture: false,
                    viewportDistanceFromLiveTailPx: 0,
                }),
                ...resolveGenericScrollObservationReadOnlyVisibleBottomEffects({
                    distanceFromLiveTailPx: 0,
                    pinEnabled: true,
                    pinnedOffsetThresholdPx: 72,
                    sessionId: 'session-a',
                }),
                first,
                second,
            ],
            sessionId: 'session-a',
        })).toEqual([first, second]);
    });

    it('preserves all current-session generic scroll-observation suppression apply effects in order', () => {
        const first = suppressionEffect();
        const second = suppressionEffect();

        expect(resolveGenericScrollObservationSuppressionApplyEffects({
            effects: [first, second],
            sessionId: 'session-a',
        })).toEqual([first, second]);
    });

    it('returns no generic observed viewport-state apply effects when none match the current session', () => {
        expect(resolveGenericScrollObservationViewportStateApplyEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveGenericScrollObservationViewportStateApplyEffects({
            effects: [observedViewportStateEffect({ sessionId: 'session-b' })],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns current-session generic observed viewport-state apply effects', () => {
        const effect = observedViewportStateEffect();

        expect(resolveGenericScrollObservationViewportStateApplyEffects({
            effects: [effect],
            sessionId: 'session-a',
        })).toEqual([effect]);
    });

    it('filters mixed effects down to current-session generic observed viewport-state apply effects', () => {
        const first = observedViewportStateEffect({
            state: resolveGenericScrollObservationViewportState({
                followIntentIsPinned: true,
                followIntentNextDistanceFromLiveTailPx: 0,
                followIntentNextScrollOffsetPx: 0,
                followIntentWantsPinned: true,
                pinEnabled: true,
                pinnedOffsetThresholdPx: 72,
                suppressAnchorCapture: false,
                viewportDistanceFromLiveTailPx: 0,
            }),
        });
        const second = observedViewportStateEffect({
            state: resolveGenericScrollObservationViewportState({
                followIntentIsPinned: false,
                followIntentNextDistanceFromLiveTailPx: 32,
                followIntentNextScrollOffsetPx: 500,
                followIntentWantsPinned: false,
                pinEnabled: true,
                pinnedOffsetThresholdPx: 72,
                suppressAnchorCapture: true,
                viewportDistanceFromLiveTailPx: 32,
            }),
        });

        expect(resolveGenericScrollObservationViewportStateApplyEffects({
            effects: [
                observedViewportStateEffect({ sessionId: 'session-b' }),
                ...resolveGenericScrollObservationReadOnlyVisibleBottomEffects({
                    distanceFromLiveTailPx: 0,
                    pinEnabled: true,
                    pinnedOffsetThresholdPx: 72,
                    sessionId: 'session-a',
                }),
                ...resolveGenericScrollObservationSuppressionEffects({
                    reason: 'native-passive-drift',
                    sessionId: 'session-a',
                }),
                first,
                second,
            ],
            sessionId: 'session-a',
        })).toEqual([first, second]);
    });

    it('preserves all current-session generic observed viewport-state apply effects in order', () => {
        const first = observedViewportStateEffect({
            state: resolveGenericScrollObservationViewportState({
                followIntentIsPinned: true,
                followIntentNextDistanceFromLiveTailPx: 0,
                followIntentNextScrollOffsetPx: 0,
                followIntentWantsPinned: true,
                pinEnabled: true,
                pinnedOffsetThresholdPx: 72,
                suppressAnchorCapture: false,
                viewportDistanceFromLiveTailPx: 0,
            }),
        });
        const second = observedViewportStateEffect({
            state: resolveGenericScrollObservationViewportState({
                followIntentIsPinned: false,
                followIntentNextDistanceFromLiveTailPx: 8,
                followIntentNextScrollOffsetPx: 120,
                followIntentWantsPinned: false,
                pinEnabled: false,
                pinnedOffsetThresholdPx: 72,
                suppressAnchorCapture: true,
                viewportDistanceFromLiveTailPx: 8,
            }),
        });

        expect(resolveGenericScrollObservationViewportStateApplyEffects({
            effects: [first, second],
            sessionId: 'session-a',
        })).toEqual([first, second]);
    });

    it('returns no read-only visible-bottom state effects when none match the current session', () => {
        expect(resolveGenericScrollObservationReadOnlyVisibleBottomStateEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);

        expect(resolveGenericScrollObservationReadOnlyVisibleBottomStateEffects({
            effects: [readOnlyVisibleBottomEffect({ sessionId: 'session-b' })],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns current-session read-only visible-bottom state effects', () => {
        const effect = readOnlyVisibleBottomEffect();

        expect(resolveGenericScrollObservationReadOnlyVisibleBottomStateEffects({
            effects: [effect],
            sessionId: 'session-a',
        })).toEqual([effect]);
    });

    it('filters mixed effects down to current-session read-only visible-bottom state effects', () => {
        const first = readOnlyVisibleBottomEffect({
            state: resolveGenericScrollObservationReadOnlyVisibleBottomState({
                distanceFromLiveTailPx: 1,
                pinEnabled: false,
                pinnedOffsetThresholdPx: 72,
            }),
        });
        const second = readOnlyVisibleBottomEffect({
            state: resolveGenericScrollObservationReadOnlyVisibleBottomState({
                distanceFromLiveTailPx: 3,
                pinEnabled: true,
                pinnedOffsetThresholdPx: 72,
            }),
        });

        expect(resolveGenericScrollObservationReadOnlyVisibleBottomStateEffects({
            effects: [
                readOnlyVisibleBottomEffect({ sessionId: 'session-b' }),
                ...resolveGenericScrollObservationViewportStateEffects({
                    followIntentIsPinned: true,
                    followIntentNextDistanceFromLiveTailPx: 0,
                    followIntentNextScrollOffsetPx: 0,
                    followIntentWantsPinned: true,
                    pinEnabled: true,
                    pinnedOffsetThresholdPx: 72,
                    sessionId: 'session-a',
                    suppressAnchorCapture: false,
                    viewportDistanceFromLiveTailPx: 0,
                }),
                ...resolveGenericScrollObservationSuppressionEffects({
                    reason: 'native-passive-drift',
                    sessionId: 'session-a',
                }),
                first,
                second,
            ],
            sessionId: 'session-a',
        })).toEqual([first, second]);
    });

    it('preserves all current-session read-only visible-bottom state effects in order', () => {
        const first = readOnlyVisibleBottomEffect({
            state: resolveGenericScrollObservationReadOnlyVisibleBottomState({
                distanceFromLiveTailPx: 4,
                pinEnabled: false,
                pinnedOffsetThresholdPx: 72,
            }),
        });
        const second = readOnlyVisibleBottomEffect({
            state: resolveGenericScrollObservationReadOnlyVisibleBottomState({
                distanceFromLiveTailPx: 8,
                pinEnabled: true,
                pinnedOffsetThresholdPx: 72,
            }),
        });

        expect(resolveGenericScrollObservationReadOnlyVisibleBottomStateEffects({
            effects: [first, second],
            sessionId: 'session-a',
        })).toEqual([first, second]);
    });
});
