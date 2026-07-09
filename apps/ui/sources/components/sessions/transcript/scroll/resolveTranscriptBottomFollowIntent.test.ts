import { describe, expect, it } from 'vitest';

import { resolveTranscriptBottomFollowIntent } from './resolveTranscriptBottomFollowIntent';

describe('resolveTranscriptBottomFollowIntent', () => {
    it('rearms max-offset lists when the user scrolls back near the bottom', () => {
        expect(resolveTranscriptBottomFollowIntent({
            canRelease: true,
            direction: 'toward-max',
            distanceFromBottom: 50,
            pinThresholdPx: 72,
            previousScrollOffset: 600,
            scrollOffset: 850,
            wantsPinned: false,
        })).toMatchObject({
            effectivePinnedOffsetThresholdPx: 72,
            isPinned: true,
            rearmed: true,
            wantsPinned: true,
        });
    });

    it('releases max-offset lists when the user scrolls away from the bottom', () => {
        expect(resolveTranscriptBottomFollowIntent({
            canRelease: true,
            direction: 'toward-max',
            distanceFromBottom: 50,
            pinThresholdPx: 72,
            previousScrollOffset: 900,
            scrollOffset: 850,
            wantsPinned: true,
        })).toMatchObject({
            effectivePinnedOffsetThresholdPx: 0,
            isPinned: false,
            released: true,
            wantsPinned: false,
        });
    });

    it('never releases follow on a moved-away observation without release authority (plan B6 trusted-gate)', () => {
        expect(resolveTranscriptBottomFollowIntent({
            canRelease: false,
            direction: 'toward-max',
            distanceFromBottom: 200,
            pinThresholdPx: 72,
            previousScrollOffset: 900,
            scrollOffset: 700,
            wantsPinned: true,
        })).toMatchObject({
            isPinned: false,
            released: false,
            wantsPinned: true,
        });
    });

    it('does not release follow mode when content growth increases the distance without user offset movement', () => {
        expect(resolveTranscriptBottomFollowIntent({
            canRelease: false,
            direction: 'toward-max',
            distanceFromBottom: 300,
            pinThresholdPx: 72,
            previousScrollOffset: 850,
            scrollOffset: 850,
            wantsPinned: true,
        })).toMatchObject({
            isPinned: false,
            released: false,
            wantsPinned: true,
        });
    });

    it('rearms zero-offset inverted lists when the user scrolls back near the bottom', () => {
        expect(resolveTranscriptBottomFollowIntent({
            canRelease: true,
            direction: 'toward-zero',
            distanceFromBottom: 48,
            pinThresholdPx: 72,
            previousScrollOffset: 300,
            scrollOffset: 48,
            wantsPinned: false,
        })).toMatchObject({
            isPinned: true,
            rearmed: true,
            wantsPinned: true,
        });
    });

    it('does not rearm on a stale bottom frame while bottom rearm is disabled', () => {
        expect(resolveTranscriptBottomFollowIntent({
            canRearmBottom: false,
            canRelease: false,
            direction: 'toward-max',
            distanceFromBottom: 0,
            pinThresholdPx: 72,
            previousScrollOffset: 1000,
            scrollOffset: 1500,
            wantsPinned: false,
        })).toMatchObject({
            isPinned: false,
            rearmed: false,
            wantsPinned: false,
        });
    });
});
