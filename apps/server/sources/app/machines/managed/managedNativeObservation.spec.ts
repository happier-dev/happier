import { describe, expect, it } from 'vitest';
import { doesManagedNativeObservationSettleIntent } from './managedNativeObservation';

describe('retained native effect observation settlement', () => {
    it.each(['start', 'stop', 'suspend', 'resume'] as const)('requires fresh definite power for %s, even when the old desired power did not happen', intent => {
        const previous = { observedAt: 10, availability: 'present', power: 'stopped' } as const;
        expect(doesManagedNativeObservationSettleIntent(intent, { ...previous, observedAt: 20 }, previous)).toBe(true);
        expect(doesManagedNativeObservationSettleIntent(intent, previous, previous)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent(intent, { ...previous, observedAt: 9 }, previous)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent(intent, { ...previous, observedAt: 20, power: 'unknown' }, previous)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent(intent, { observedAt: 20, availability: 'unavailable' }, previous)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent(intent, { observedAt: 20, availability: 'absent' }, previous)).toBe(true);
    });
    it('requires absence for Delete and a bound replacement for Rebuild', () => {
        const present = { observedAt: 20, availability: 'present', power: 'stopped' } as const;
        expect(doesManagedNativeObservationSettleIntent('delete', present)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent('delete', { observedAt: 20, availability: 'absent' })).toBe(true);
        expect(doesManagedNativeObservationSettleIntent('rebuild', present)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent('rebuild', { observedAt: 20, availability: 'absent' })).toBe(false);
    });
    it('allows a newly admitted Delete retry only after a fresh present observation', () => {
        const previous = { observedAt: 10, availability: 'present', power: 'stopped' } as const;
        expect(doesManagedNativeObservationSettleIntent('delete', { ...previous, observedAt: 20 }, previous, true)).toBe(true);
        expect(doesManagedNativeObservationSettleIntent('delete', previous, previous, true)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent('delete', { observedAt: 20, availability: 'unavailable' }, previous, true)).toBe(false);
        expect(doesManagedNativeObservationSettleIntent('rebuild', { ...previous, observedAt: 20 }, previous, true)).toBe(false);
    });
});
