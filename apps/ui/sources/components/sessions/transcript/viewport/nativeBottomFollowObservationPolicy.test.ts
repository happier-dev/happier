import { describe, expect, it } from 'vitest';

import {
    nativeBottomFollowCanApplyCompletion,
    nativeBottomFollowCanCompletePendingPin,
    nativeBottomFollowPinTargetObserved,
} from './nativeBottomFollowObservationPolicy';

describe('native bottom-follow observation policy', () => {
    it('observes pending bottom-pin targets by threshold distance or clamped overshoot', () => {
        expect(nativeBottomFollowPinTargetObserved({
            lastNativePinOffset: 1000,
            pinThresholdPx: 12,
            visualBottomScrollOffset: 990,
        })).toBe(true);

        expect(nativeBottomFollowPinTargetObserved({
            lastNativePinOffset: 1000,
            pinThresholdPx: 12,
            visualBottomScrollOffset: 1300,
        })).toBe(false);

        expect(nativeBottomFollowPinTargetObserved({
            lastNativePinOffset: 1000,
            pinThresholdPx: 12,
            visualBottomScrollOffset: null,
        })).toBe(false);
    });

    it('allows pending bottom-follow completion when settle is stable, deadline reached, no pin is pending, or the target was observed', () => {
        expect(nativeBottomFollowCanCompletePendingPin({
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
            pendingBottomPin: true,
            pinTargetObserved: false,
        })).toBe(false);

        expect(nativeBottomFollowCanCompletePendingPin({
            mountSettleDeadlineReached: false,
            mountSettleStable: true,
            pendingBottomPin: true,
            pinTargetObserved: false,
        })).toBe(true);

        expect(nativeBottomFollowCanCompletePendingPin({
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
            pendingBottomPin: false,
            pinTargetObserved: false,
        })).toBe(true);

        expect(nativeBottomFollowCanCompletePendingPin({
            mountSettleDeadlineReached: false,
            mountSettleStable: false,
            pendingBottomPin: true,
            pinTargetObserved: true,
        })).toBe(true);
    });

    it('applies native bottom-follow completion only when pinned, at bottom, and completion is allowed', () => {
        expect(nativeBottomFollowCanApplyCompletion({
            canCompletePendingPin: true,
            distanceFromBottom: 8,
            isNative: true,
            pinThresholdPx: 10,
            wantsPinned: true,
        })).toBe(true);

        expect(nativeBottomFollowCanApplyCompletion({
            canCompletePendingPin: true,
            distanceFromBottom: 18,
            isNative: true,
            pinThresholdPx: 10,
            wantsPinned: true,
        })).toBe(false);

        expect(nativeBottomFollowCanApplyCompletion({
            canCompletePendingPin: true,
            distanceFromBottom: 8,
            isNative: false,
            pinThresholdPx: 10,
            wantsPinned: true,
        })).toBe(false);
    });
});
