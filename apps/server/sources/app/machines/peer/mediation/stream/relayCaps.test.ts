import { describe, expect, it } from 'vitest';

import {
    hasMachineLiveStreamRelayCaps,
    normalizeMachineLiveStreamRelayCaps,
} from './relayCaps';

describe('machine live-stream relay caps', () => {
    it('requires positive finite relay caps before server relay can be enabled', () => {
        expect(normalizeMachineLiveStreamRelayCaps({
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 12,
            maxFrameBytes: 32_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
            maxConcurrentStreamsPerAccount: 2,
            maxConcurrentStreamsPerSocket: 1,
            maxConcurrentStreamsPerMachine: 1,
        })).toEqual({
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 12,
            maxFrameBytes: 32_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
            maxConcurrentStreamsPerAccount: 2,
            maxConcurrentStreamsPerSocket: 1,
            maxConcurrentStreamsPerMachine: 1,
        });

        expect(hasMachineLiveStreamRelayCaps(null)).toBe(false);
        expect(normalizeMachineLiveStreamRelayCaps({
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 0,
            maxFrameBytes: 32_000,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
            maxConcurrentStreamsPerAccount: 2,
            maxConcurrentStreamsPerSocket: 1,
            maxConcurrentStreamsPerMachine: 1,
        })).toBeNull();
    });
});
