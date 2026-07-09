import { describe, expect, it } from 'vitest';

import {
    resolveNativeMomentumSettleAwayReleaseStateEffects,
    type NativeMomentumSettleAwayReleaseInputEffect,
} from './nativeMomentumSettleAwayRelease';

const releaseEffect = (overrides: Partial<NativeMomentumSettleAwayReleaseInputEffect> = {}): NativeMomentumSettleAwayReleaseInputEffect => ({
    distanceFromLiveTailPx: 18.75,
    sessionId: 'session-a',
    type: 'native-momentum-settle-away-release-live-tail',
    ...overrides,
});

describe('native momentum settle-away release', () => {
    it('maps a matching release effect to released viewport and scroll-pin state', () => {
        expect(resolveNativeMomentumSettleAwayReleaseStateEffects({
            effects: [releaseEffect()],
            pinEnabled: true,
            sessionId: 'session-a',
            wantsPinned: true,
        })).toEqual([{
            distanceFromLiveTailPx: 18.75,
            scrollPinEvent: {
                enabled: true,
                offsetY: 18.75,
                pinnedOffsetThresholdPx: 0,
                type: 'scroll',
            },
            sessionId: 'session-a',
            type: 'apply-native-momentum-settle-away-release-state',
            viewportState: {
                isPinned: false,
                offsetY: 18.75,
                shouldRestoreViewport: true,
            },
        }]);
    });

    it('does not emit release state when follow is already released', () => {
        expect(resolveNativeMomentumSettleAwayReleaseStateEffects({
            effects: [releaseEffect()],
            pinEnabled: true,
            sessionId: 'session-a',
            wantsPinned: false,
        })).toEqual([]);
    });

    it('does not emit release state for a stale session', () => {
        expect(resolveNativeMomentumSettleAwayReleaseStateEffects({
            effects: [releaseEffect({ sessionId: 'session-b' })],
            pinEnabled: true,
            sessionId: 'session-a',
            wantsPinned: true,
        })).toEqual([]);
    });

    it('does not emit release state without a release effect', () => {
        expect(resolveNativeMomentumSettleAwayReleaseStateEffects({
            effects: [],
            pinEnabled: true,
            sessionId: 'session-a',
            wantsPinned: true,
        })).toEqual([]);
    });

    it('copies disabled pin state into the scroll-pin event', () => {
        expect(resolveNativeMomentumSettleAwayReleaseStateEffects({
            effects: [releaseEffect()],
            pinEnabled: false,
            sessionId: 'session-a',
            wantsPinned: true,
        })[0]?.scrollPinEvent.enabled).toBe(false);
    });
});
