import { describe, expect, it } from 'vitest';

import {
    resolveNativeScrollReadOnlyVisibleBottomDecision,
    resolveNativeScrollReadOnlyVisibleBottomGenericEffects,
} from './nativeScrollReadOnlyVisibleBottom';

describe('native scroll read-only visible-bottom decision', () => {
    it('records passive native visible-bottom observations while released', () => {
        expect(resolveNativeScrollReadOnlyVisibleBottomDecision({
            bottomFollowMode: 'released',
            distanceFromLiveTailPx: 0,
            followIntentIsPinned: true,
            followIntentWantsPinned: true,
            isNative: true,
            isTrusted: false,
            pinnedOffsetThresholdPx: 72,
        })).toEqual({
            distanceFromLiveTailPx: 0,
            pinnedOffsetThresholdPx: 72,
            type: 'record-visible-bottom',
        });
    });

    it('ignores trusted observations', () => {
        expect(resolveNativeScrollReadOnlyVisibleBottomDecision({
            bottomFollowMode: 'released',
            distanceFromLiveTailPx: 0,
            followIntentIsPinned: true,
            followIntentWantsPinned: true,
            isNative: true,
            isTrusted: true,
            pinnedOffsetThresholdPx: 72,
        })).toEqual({
            reason: 'trusted-observation',
            type: 'ignore',
        });
    });

    it('ignores observations while already following', () => {
        expect(resolveNativeScrollReadOnlyVisibleBottomDecision({
            bottomFollowMode: 'following',
            distanceFromLiveTailPx: 0,
            followIntentIsPinned: true,
            followIntentWantsPinned: true,
            isNative: true,
            isTrusted: false,
            pinnedOffsetThresholdPx: 72,
        })).toEqual({
            reason: 'already-following',
            type: 'ignore',
        });
    });

    it('ignores observations when the resolved intent is not visibly pinned', () => {
        expect(resolveNativeScrollReadOnlyVisibleBottomDecision({
            bottomFollowMode: 'released',
            distanceFromLiveTailPx: 96,
            followIntentIsPinned: false,
            followIntentWantsPinned: true,
            isNative: true,
            isTrusted: false,
            pinnedOffsetThresholdPx: 72,
        })).toEqual({
            reason: 'not-visible-live-tail',
            type: 'ignore',
        });
    });

    it('ignores observations when the resolved intent does not want the live tail', () => {
        expect(resolveNativeScrollReadOnlyVisibleBottomDecision({
            bottomFollowMode: 'released',
            distanceFromLiveTailPx: 0,
            followIntentIsPinned: true,
            followIntentWantsPinned: false,
            isNative: true,
            isTrusted: false,
            pinnedOffsetThresholdPx: 72,
        })).toEqual({
            reason: 'not-wants-pinned',
            type: 'ignore',
        });
    });

    it('creates a session-scoped generic read-only visible-bottom effect for record decisions', () => {
        expect(resolveNativeScrollReadOnlyVisibleBottomGenericEffects({
            distanceFromLiveTailPx: 3.5,
            pinnedOffsetThresholdPx: 72,
            type: 'record-visible-bottom',
        }, {
            pinEnabled: true,
            sessionId: 'session-a',
        })).toEqual([{
            sessionId: 'session-a',
            state: {
                jumpButtonDistanceFromLiveTailPx: 3.5,
                lastDistanceFromLiveTailPx: 3.5,
                scrollPinEvent: {
                    enabled: true,
                    offsetY: 3.5,
                    pinnedOffsetThresholdPx: 72,
                    type: 'scroll',
                },
            },
            type: 'apply-generic-read-only-visible-bottom-state',
        }]);
    });

    it('creates no effects for ignored decisions', () => {
        expect(resolveNativeScrollReadOnlyVisibleBottomGenericEffects({
            reason: 'trusted-observation',
            type: 'ignore',
        }, {
            pinEnabled: true,
            sessionId: 'session-a',
        })).toEqual([]);
    });
});
