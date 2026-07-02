import { describe, expect, it } from 'vitest';

import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import { hasMeaningfulActivityAfterRuntimeIssue } from './sessionUsageLimitActivityStaleness';

function usageLimitIssue(occurredAt: number): SessionRuntimeIssueV1 {
    return {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt,
        provider: 'pi',
        usageLimit: {
            v: 1,
            resetAtMs: null,
            retryAfterMs: null,
            quotaScope: 'unknown',
            recoverability: 'wait',
        },
    };
}

describe('hasMeaningfulActivityAfterRuntimeIssue', () => {
    it('does not treat post-failure lifecycle activity as a stale usage-limit issue', () => {
        expect(hasMeaningfulActivityAfterRuntimeIssue({
            meaningfulActivityAt: 18_000,
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 10_001,
            lastRuntimeIssue: usageLimitIssue(10_000),
        })).toBe(false);
    });

    it('treats later failed-turn activity as stale when it is not the recorded usage-limit failure', () => {
        expect(hasMeaningfulActivityAfterRuntimeIssue({
            meaningfulActivityAt: 18_000,
            latestTurnStatus: 'failed',
            latestTurnStatusObservedAt: 16_000,
            lastRuntimeIssue: usageLimitIssue(10_000),
        })).toBe(true);
    });
});
