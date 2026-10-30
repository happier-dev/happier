import { describe, expect, it } from 'vitest';

import {
    resolveQuotaMeterTone,
    resolveQuotaTone,
} from './resolveQuotaTone';

describe('resolveQuotaTone', () => {
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

    it('colours a reported meter by what is left, and a meter without a trustworthy value as neutral', () => {
        expect(resolveQuotaMeterTone({ remainingPct: 25, status: 'ok' })).toBe('warning');
        expect(resolveQuotaMeterTone({ remainingPct: 5, status: 'ok' })).toBe('danger');
        // Unavailable and estimated values carry no health claim.
        expect(resolveQuotaMeterTone({ remainingPct: 5, status: 'unavailable' })).toBe('neutral');
        expect(resolveQuotaMeterTone({ remainingPct: 5, status: 'estimated' })).toBe('neutral');
    });
});
