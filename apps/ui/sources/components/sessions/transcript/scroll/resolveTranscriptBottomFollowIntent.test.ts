import { describe, expect, it } from 'vitest';

import { resolveTranscriptBottomFollowIntent } from './resolveTranscriptBottomFollowIntent';

describe('resolveTranscriptBottomFollowIntent', () => {
    it('rearms max-offset lists when the user scrolls back near the bottom', () => {
        expect(resolveTranscriptBottomFollowIntent({
            direction: 'toward-max',
            distanceFromBottom: 50,
            pinThresholdPx: 72,
            previousScrollOffset: 600,
            recentUserIntent: true,
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
            direction: 'toward-max',
            distanceFromBottom: 50,
            pinThresholdPx: 72,
            previousScrollOffset: 900,
            recentUserIntent: true,
            scrollOffset: 850,
            wantsPinned: true,
        })).toMatchObject({
            effectivePinnedOffsetThresholdPx: 0,
            isPinned: false,
            released: true,
            wantsPinned: false,
        });
    });

    it('does not release follow mode when content growth increases the distance without user offset movement', () => {
        expect(resolveTranscriptBottomFollowIntent({
            direction: 'toward-max',
            distanceFromBottom: 300,
            pinThresholdPx: 72,
            previousScrollOffset: 850,
            recentUserIntent: false,
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
            direction: 'toward-zero',
            distanceFromBottom: 48,
            pinThresholdPx: 72,
            previousScrollOffset: 300,
            recentUserIntent: true,
            scrollOffset: 48,
            wantsPinned: false,
        })).toMatchObject({
            isPinned: true,
            rearmed: true,
            wantsPinned: true,
        });
    });
});
