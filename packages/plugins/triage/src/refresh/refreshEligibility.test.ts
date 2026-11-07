import { describe, expect, it } from 'vitest';

import { evaluateRefreshEligibility, isTriageRefreshPacingBlockActiveV1 } from './refreshEligibility.js';

const NOW_MS = 1_700_000_000_000;

describe('triage refresh eligibility', () => {
    it('admits demand when the source has stated no retry deadline', () => {
        expect(evaluateRefreshEligibility({ nowMs: NOW_MS, retryNotBeforeMs: null }))
            .toEqual({ kind: 'eligible' });
    });

    it('blocks until the exact provider deadline and admits demand at its boundary', () => {
        expect(evaluateRefreshEligibility({ nowMs: NOW_MS, retryNotBeforeMs: NOW_MS + 10 }))
            .toEqual({ kind: 'blocked', reason: 'sourceRetryDeadline', nextEligibleAtMs: NOW_MS + 10 });
        expect(evaluateRefreshEligibility({ nowMs: NOW_MS + 10, retryNotBeforeMs: NOW_MS + 10 }))
            .toEqual({ kind: 'eligible' });
    });

    it('preserves a source-stated absolute deadline without inventing a retry horizon', () => {
        const deadline = NOW_MS + 30 * 24 * 60 * 60 * 1_000;
        expect(evaluateRefreshEligibility({ nowMs: NOW_MS + 60 * 60 * 1_000, retryNotBeforeMs: deadline }))
            .toEqual({ kind: 'blocked', reason: 'sourceRetryDeadline', nextEligibleAtMs: deadline });
    });

    it('uses the same active deadline boundary for controls and refresh admission', () => {
        const block = { reason: 'sourceRetryDeadline', nextEligibleAtMs: NOW_MS + 10 } as const;
        expect(isTriageRefreshPacingBlockActiveV1(block, NOW_MS + 9)).toBe(true);
        expect(isTriageRefreshPacingBlockActiveV1(block, NOW_MS + 10)).toBe(false);
        expect(isTriageRefreshPacingBlockActiveV1(null, NOW_MS)).toBe(false);
    });
});
