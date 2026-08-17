import { describe, expect, it } from 'vitest';

import {
    compareAccountHealthSeverity,
    deriveAccountHealth,
    worstAccountHealth,
    type AccountHealth,
} from './deriveAccountHealth';

describe('deriveAccountHealth', () => {
    it('is healthy when status is connected and capacity is comfortable', () => {
        expect(deriveAccountHealth({ status: 'connected', capacityPct: 80, isStale: false })).toBe('healthy');
    });

    it('treats no quota data as healthy (neutral tone is not an error)', () => {
        expect(deriveAccountHealth({ status: 'connected', capacityPct: null })).toBe('healthy');
    });

    it('maps needs_reauth to error and refresh_failed_retryable to attention', () => {
        expect(deriveAccountHealth({ status: 'needs_reauth', capacityPct: 90 })).toBe('error');
        expect(deriveAccountHealth({ status: 'refresh_failed_retryable', capacityPct: 90 })).toBe('attention');
    });

    it('aligns the capacity dimension with the quota tone at the 10% boundary', () => {
        // resolveQuotaTone: <=10 danger -> error, <=25 warning -> attention.
        expect(deriveAccountHealth({ status: 'connected', capacityPct: 11 })).toBe('attention');
        expect(deriveAccountHealth({ status: 'connected', capacityPct: 10 })).toBe('error');
        expect(deriveAccountHealth({ status: 'connected', capacityPct: 9 })).toBe('error');
        expect(deriveAccountHealth({ status: 'connected', capacityPct: 26 })).toBe('healthy');
    });

    it('treats staleness as at least attention', () => {
        expect(deriveAccountHealth({ status: 'connected', capacityPct: 90, isStale: true })).toBe('attention');
    });

    it('takes the worst-of across every dimension', () => {
        // attention status but danger capacity -> error wins.
        expect(deriveAccountHealth({ status: 'refresh_failed_retryable', capacityPct: 5 })).toBe('error');
        // stale attention but needs_reauth error -> error wins.
        expect(deriveAccountHealth({ status: 'needs_reauth', capacityPct: 90, isStale: true })).toBe('error');
    });
});

describe('worstAccountHealth', () => {
    it('returns the most severe value regardless of position', () => {
        expect(worstAccountHealth(['healthy', 'error', 'attention'])).toBe('error');
        expect(worstAccountHealth(['attention', 'healthy'])).toBe('attention');
        expect(worstAccountHealth(['healthy', 'healthy'])).toBe('healthy');
    });

    it('treats an empty set as healthy (nothing is wrong yet)', () => {
        expect(worstAccountHealth([])).toBe('healthy');
    });
});

describe('compareAccountHealthSeverity', () => {
    it('sorts attention-first: error, then attention, then healthy', () => {
        const sorted = (['healthy', 'attention', 'error', 'healthy'] satisfies AccountHealth[])
            .slice()
            .sort(compareAccountHealthSeverity);
        expect(sorted).toEqual(['error', 'attention', 'healthy', 'healthy']);
    });

    it('is zero for equal severities so callers keep their own tiebreak', () => {
        expect(compareAccountHealthSeverity('attention', 'attention')).toBe(0);
    });
});
