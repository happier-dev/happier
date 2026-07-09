import { describe, expect, it } from 'vitest';

import {
    resolveNativeBottomFollowRearmResetEffects,
    type NativeBottomFollowRearmResetInputEffect,
} from './nativeBottomFollowRearmReset';

const resetEffect = (
    overrides: Partial<NativeBottomFollowRearmResetInputEffect> = {},
): NativeBottomFollowRearmResetInputEffect => ({
    sessionId: 'session-a',
    type: 'native-bottom-follow-rearm-reset',
    ...overrides,
});

describe('native bottom-follow rearm reset', () => {
    it('returns no effects when no reset effect exists', () => {
        expect(resolveNativeBottomFollowRearmResetEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('ignores stale-session reset effects', () => {
        expect(resolveNativeBottomFollowRearmResetEffects({
            effects: [resetEffect({ sessionId: 'session-b' })],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns a typed reset effect for the current session', () => {
        expect(resolveNativeBottomFollowRearmResetEffects({
            effects: [resetEffect()],
            sessionId: 'session-a',
        })).toEqual([{
            sessionId: 'session-a',
            type: 'reset-native-bottom-follow-rearm',
        }]);
    });

    it('filters mixed effects down to current-session resets', () => {
        expect(resolveNativeBottomFollowRearmResetEffects({
            effects: [
                resetEffect({ sessionId: 'session-b' }),
                {
                    distanceFromLiveTailPx: 4,
                    sessionId: 'session-a',
                    type: 'native-bottom-follow-rearm',
                },
                resetEffect(),
            ],
            sessionId: 'session-a',
        })).toEqual([{
            sessionId: 'session-a',
            type: 'reset-native-bottom-follow-rearm',
        }]);
    });

    it('preserves the count and order of current-session reset effects', () => {
        expect(resolveNativeBottomFollowRearmResetEffects({
            effects: [
                resetEffect(),
                resetEffect({ sessionId: 'session-b' }),
                resetEffect(),
            ],
            sessionId: 'session-a',
        })).toEqual([
            {
                sessionId: 'session-a',
                type: 'reset-native-bottom-follow-rearm',
            },
            {
                sessionId: 'session-a',
                type: 'reset-native-bottom-follow-rearm',
            },
        ]);
    });
});
