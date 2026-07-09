import { describe, expect, it } from 'vitest';

import {
    resolveNativeTouchReleaseLiveTailStateEffects,
    type NativeTouchReleaseLiveTailInputEffect,
} from './nativeTouchReleaseLiveTail';

const touchReleaseEffect = (
    overrides: Partial<NativeTouchReleaseLiveTailInputEffect> = {},
): NativeTouchReleaseLiveTailInputEffect => ({
    distanceFromLiveTailPx: 7,
    sessionId: 'session-a',
    type: 'native-touch-release-live-tail',
    ...overrides,
});

describe('native touch release live-tail state effects', () => {
    it('returns no state effects when no touch release effect exists', () => {
        expect(resolveNativeTouchReleaseLiveTailStateEffects({
            effects: [],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('ignores stale-session touch release effects', () => {
        expect(resolveNativeTouchReleaseLiveTailStateEffects({
            effects: [touchReleaseEffect({ sessionId: 'session-b' })],
            sessionId: 'session-a',
        })).toEqual([]);
    });

    it('returns one state effect for a current-session touch release', () => {
        expect(resolveNativeTouchReleaseLiveTailStateEffects({
            effects: [touchReleaseEffect()],
            sessionId: 'session-a',
        })).toEqual([{
            sessionId: 'session-a',
            type: 'apply-native-touch-release-live-tail-state',
        }]);
    });

    it('filters mixed effects down to the current-session touch release', () => {
        expect(resolveNativeTouchReleaseLiveTailStateEffects({
            effects: [
                touchReleaseEffect({ sessionId: 'session-b' }),
                {
                    distanceFromLiveTailPx: 3,
                    sessionId: 'session-a',
                    type: 'native-bottom-follow-rearm',
                },
                touchReleaseEffect(),
            ],
            sessionId: 'session-a',
        })).toEqual([{
            sessionId: 'session-a',
            type: 'apply-native-touch-release-live-tail-state',
        }]);
    });

    it('preserves first-match behavior when multiple current-session touch release effects exist', () => {
        expect(resolveNativeTouchReleaseLiveTailStateEffects({
            effects: [
                touchReleaseEffect({ distanceFromLiveTailPx: 4 }),
                touchReleaseEffect({ distanceFromLiveTailPx: 1 }),
            ],
            sessionId: 'session-a',
        })).toEqual([{
            sessionId: 'session-a',
            type: 'apply-native-touch-release-live-tail-state',
        }]);
    });
});
