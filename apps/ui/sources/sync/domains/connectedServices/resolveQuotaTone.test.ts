import { describe, expect, it } from 'vitest';

import {
    QUOTA_REMAINING_CRITICAL_THRESHOLD_PCT,
    QUOTA_REMAINING_WARNING_THRESHOLD_PCT,
    resolveQuotaTone,
} from './resolveQuotaTone';

describe('resolveQuotaTone', () => {
    it('exposes the preserved threshold constants', () => {
        // These boundaries are the source of truth previously duplicated in the
        // gauge + the meter row + the agent-input badge.
        expect(QUOTA_REMAINING_CRITICAL_THRESHOLD_PCT).toBe(10);
        expect(QUOTA_REMAINING_WARNING_THRESHOLD_PCT).toBe(25);
    });

    it('maps remaining percentage to a meter tone with the preserved <=10 critical boundary', () => {
        expect(resolveQuotaTone(100)).toBe('success');
        expect(resolveQuotaTone(26)).toBe('success');
        expect(resolveQuotaTone(25)).toBe('warning');
        expect(resolveQuotaTone(11)).toBe('warning');
        // Exactly 10% stays danger — preserves the current behavior.
        expect(resolveQuotaTone(10)).toBe('danger');
        expect(resolveQuotaTone(9)).toBe('danger');
        expect(resolveQuotaTone(0)).toBe('danger');
    });

    it('returns neutral when there is no finite data', () => {
        expect(resolveQuotaTone(null)).toBe('neutral');
        expect(resolveQuotaTone(Number.NaN)).toBe('neutral');
        expect(resolveQuotaTone(Number.POSITIVE_INFINITY)).toBe('neutral');
    });
});
