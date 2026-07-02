import { describe, expect, it } from 'vitest';

import {
    DEFAULT_JSONL_FOLLOW_POLICY,
    normalizeJsonlFollowPolicy,
    resolveJsonlFollowPollDelayMs,
} from './followPolicy';
import type { JsonlFollowPolicyV1 } from './followPolicy';

describe('JSONL follow policy', () => {
    it('defines the named A.12.1 default caps', () => {
        const policy = DEFAULT_JSONL_FOLLOW_POLICY satisfies JsonlFollowPolicyV1;

        expect(policy).toEqual({
            activeBurstPollIntervalMs: 250,
            activeBurstDurationMs: 5_000,
            activeFallbackPollIntervalMs: 1_000,
            idleFallbackPollIntervalMs: 5_000,
            missingFileRetryIntervalMs: 1_000,
            sidechainCompletionGraceMs: 2_000,
            maxActiveFollowersPerSession: 64,
            maxIdleFollowersPerSession: 128,
            maxClosedFollowerRecordsPerSession: 256,
            maxBufferedSidechainRows: 1_000,
            maxBufferedSidechainBytes: 1_048_576,
            maxDrainRowsPerTick: 1_000,
            maxDrainBytesPerTick: 262_144,
        });
    });

    it('uses burst, active fallback, idle fallback, and missing-file delays from named policy fields', () => {
        const policy = normalizeJsonlFollowPolicy({
            activeBurstPollIntervalMs: 25,
            activeBurstDurationMs: 100,
            activeFallbackPollIntervalMs: 250,
            idleFallbackPollIntervalMs: 2_000,
            missingFileRetryIntervalMs: 500,
        });

        expect(resolveJsonlFollowPollDelayMs(policy, {
            nowMs: 1_000,
            lastActivityAtMs: 950,
            idle: false,
            missingFile: false,
        })).toBe(25);
        expect(resolveJsonlFollowPollDelayMs(policy, {
            nowMs: 1_000,
            lastActivityAtMs: 500,
            idle: false,
            missingFile: false,
        })).toBe(250);
        expect(resolveJsonlFollowPollDelayMs(policy, {
            nowMs: 1_000,
            lastActivityAtMs: 500,
            idle: true,
            missingFile: false,
        })).toBe(2_000);
        expect(resolveJsonlFollowPollDelayMs(policy, {
            nowMs: 1_000,
            lastActivityAtMs: 950,
            idle: true,
            missingFile: false,
        })).toBe(25);
        expect(resolveJsonlFollowPollDelayMs(policy, {
            nowMs: 1_000,
            lastActivityAtMs: 950,
            idle: false,
            missingFile: true,
        })).toBe(500);
    });
});
