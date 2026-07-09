import { describe, expect, it } from 'vitest';

import { resolveNativeScrollFollowIntentReleaseDecision } from './nativeScrollFollowIntentRelease';

describe('native scroll follow-intent release decision', () => {
    it('allows trusted inverted movement beyond the pin threshold to release', () => {
        expect(resolveNativeScrollFollowIntentReleaseDecision({
            distanceFromLiveTailPx: 120,
            hasTrustedDragSession: false,
            isTrusted: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
        })).toEqual({ type: 'allow-release' });
    });

    it('blocks trusted inverted movement inside the pin threshold', () => {
        expect(resolveNativeScrollFollowIntentReleaseDecision({
            distanceFromLiveTailPx: 40,
            hasTrustedDragSession: false,
            isTrusted: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
        })).toEqual({
            reason: 'inside-inverted-pin-threshold',
            type: 'block-release',
        });
    });

    it('allows untrusted momentum with a retained trusted drag session beyond the threshold', () => {
        expect(resolveNativeScrollFollowIntentReleaseDecision({
            distanceFromLiveTailPx: 180,
            hasTrustedDragSession: true,
            isTrusted: false,
            nativeMomentumScrollActive: true,
            pinThresholdPx: 72,
        })).toEqual({ type: 'allow-release' });
    });

    it('blocks untrusted momentum without a retained trusted drag session', () => {
        expect(resolveNativeScrollFollowIntentReleaseDecision({
            distanceFromLiveTailPx: 180,
            hasTrustedDragSession: false,
            isTrusted: false,
            nativeMomentumScrollActive: true,
            pinThresholdPx: 72,
        })).toEqual({
            reason: 'missing-release-authority',
            type: 'block-release',
        });
    });

    it('blocks stale native-standard-shaped input inside the pin threshold', () => {
        expect(resolveNativeScrollFollowIntentReleaseDecision({
            distanceFromLiveTailPx: 0,
            hasTrustedDragSession: false,
            isTrusted: true,
            nativeMomentumScrollActive: false,
            pinThresholdPx: 72,
        })).toEqual({
            reason: 'inside-inverted-pin-threshold',
            type: 'block-release',
        });
    });
});
