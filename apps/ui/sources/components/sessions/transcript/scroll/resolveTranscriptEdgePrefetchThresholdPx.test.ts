import { describe, expect, it } from 'vitest';

import { resolveTranscriptEdgePrefetchThresholdPx } from './resolveTranscriptEdgePrefetchThresholdPx';

const baseInput = {
    configuredPx: Number.NaN,
    viewportPx: 500,
    fallbackViewportRatio: 0.2,
    minPx: 40,
    maxPx: 800,
};

describe('resolveTranscriptEdgePrefetchThresholdPx', () => {
    it('clamps positive configured values into the allowed range', () => {
        expect(resolveTranscriptEdgePrefetchThresholdPx({
            ...baseInput,
            configuredPx: 20,
        })).toBe(40);

        expect(resolveTranscriptEdgePrefetchThresholdPx({
            ...baseInput,
            configuredPx: 900,
        })).toBe(800);

        expect(resolveTranscriptEdgePrefetchThresholdPx({
            ...baseInput,
            configuredPx: 123.9,
        })).toBe(123);
    });

    it('returns zero when configured prefetch is disabled', () => {
        expect(resolveTranscriptEdgePrefetchThresholdPx({
            ...baseInput,
            configuredPx: 0,
        })).toBe(0);
    });

    it('falls back to the viewport ratio for invalid configured values', () => {
        expect(resolveTranscriptEdgePrefetchThresholdPx({
            ...baseInput,
            configuredPx: Number.NaN,
        })).toBe(100);

        expect(resolveTranscriptEdgePrefetchThresholdPx({
            ...baseInput,
            configuredPx: -1,
        })).toBe(100);
    });

    it('uses the minimum threshold when the fallback viewport is invalid', () => {
        expect(resolveTranscriptEdgePrefetchThresholdPx({
            ...baseInput,
            configuredPx: Number.NaN,
            viewportPx: 0,
        })).toBe(40);
    });
});
