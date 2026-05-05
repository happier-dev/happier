import { describe, expect, it } from 'vitest';

import type { WebTranscriptScrollMetrics } from '../webTranscriptScrollMetrics';
import { resolveWebBottomFollowAdjustment } from './resolveWebBottomFollowAdjustment';

function metrics(params: Readonly<{
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
}>): WebTranscriptScrollMetrics {
    return {
        element: {} as HTMLElement,
        clientHeight: params.clientHeight,
        scrollHeight: params.scrollHeight,
        scrollTop: params.scrollTop,
    };
}

describe('resolveWebBottomFollowAdjustment', () => {
    it('preserves distance from bottom when followed content grows', () => {
        expect(resolveWebBottomFollowAdjustment({
            mode: 'following',
            tolerancePx: 72,
            previousMetrics: metrics({ clientHeight: 100, scrollHeight: 1000, scrollTop: 892 }),
            nextMetrics: metrics({ clientHeight: 100, scrollHeight: 1400, scrollTop: 892 }),
        })).toBe(1292);
    });

    it('does not adjust when the user has released the bottom follow', () => {
        expect(resolveWebBottomFollowAdjustment({
            mode: 'released',
            tolerancePx: 72,
            previousMetrics: metrics({ clientHeight: 100, scrollHeight: 1000, scrollTop: 892 }),
            nextMetrics: metrics({ clientHeight: 100, scrollHeight: 1400, scrollTop: 892 }),
        })).toBeNull();
    });

    it('does not adjust when recent user intent is present', () => {
        expect(resolveWebBottomFollowAdjustment({
            mode: 'following',
            recentUserIntent: true,
            tolerancePx: 72,
            previousMetrics: metrics({ clientHeight: 100, scrollHeight: 1000, scrollTop: 892 }),
            nextMetrics: metrics({ clientHeight: 100, scrollHeight: 1400, scrollTop: 892 }),
        })).toBeNull();
    });

    it('clamps shrink and viewport changes to the next scroll range', () => {
        expect(resolveWebBottomFollowAdjustment({
            mode: 'following',
            tolerancePx: 72,
            previousMetrics: metrics({ clientHeight: 100, scrollHeight: 1000, scrollTop: 900 }),
            nextMetrics: metrics({ clientHeight: 250, scrollHeight: 900, scrollTop: 900 }),
        })).toBe(650);
    });
});
