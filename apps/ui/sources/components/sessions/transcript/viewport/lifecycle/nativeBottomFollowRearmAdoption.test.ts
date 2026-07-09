import { describe, expect, it } from 'vitest';

import {
    resolveNativeBottomFollowRearmAdoptionDecision,
    type NativeBottomFollowRearmAdoptionInputEffect,
} from './nativeBottomFollowRearmAdoption';

const rearmEffect = (overrides: Partial<NativeBottomFollowRearmAdoptionInputEffect> = {}): NativeBottomFollowRearmAdoptionInputEffect => ({
    distanceFromLiveTailPx: 9.5,
    sessionId: 'session-a',
    type: 'native-bottom-follow-rearm',
    ...overrides,
});

describe('native bottom-follow rearm adoption', () => {
    it('returns not consumed when no matching rearm effect exists', () => {
        expect(resolveNativeBottomFollowRearmAdoptionDecision({
            effects: [],
            hasRearmedNativeBottomFollow: false,
            sessionId: 'session-a',
        })).toEqual({ consumed: false, effects: [] });
    });

    it('ignores stale-session rearm effects', () => {
        expect(resolveNativeBottomFollowRearmAdoptionDecision({
            effects: [rearmEffect({ sessionId: 'session-b' })],
            hasRearmedNativeBottomFollow: false,
            sessionId: 'session-a',
        })).toEqual({ consumed: false, effects: [] });
    });

    it('returns adoption when a matching rearm is not already applied', () => {
        expect(resolveNativeBottomFollowRearmAdoptionDecision({
            effects: [rearmEffect()],
            hasRearmedNativeBottomFollow: false,
            sessionId: 'session-a',
        })).toEqual({
            consumed: true,
            effects: [{
                distanceFromLiveTailPx: 9.5,
                sessionId: 'session-a',
                type: 'adopt-native-bottom-follow-rearm',
            }],
        });
    });

    it('consumes a matching rearm without adoption after native bottom follow is already rearmed', () => {
        expect(resolveNativeBottomFollowRearmAdoptionDecision({
            effects: [rearmEffect()],
            hasRearmedNativeBottomFollow: true,
            sessionId: 'session-a',
        })).toEqual({ consumed: true, effects: [] });
    });

    it('uses the first matching rearm effect for the current session', () => {
        expect(resolveNativeBottomFollowRearmAdoptionDecision({
            effects: [
                rearmEffect({ distanceFromLiveTailPx: 4 }),
                rearmEffect({ distanceFromLiveTailPx: 1 }),
            ],
            hasRearmedNativeBottomFollow: false,
            sessionId: 'session-a',
        }).effects[0]?.distanceFromLiveTailPx).toBe(4);
    });
});
