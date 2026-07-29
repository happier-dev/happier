import { describe, expect, it } from 'vitest';

import { deriveAccountCapacityPct } from './deriveAccountCapacityPct';

describe('deriveAccountCapacityPct', () => {
    it('returns the minimum remaining percentage across meter rows', () => {
        expect(
            deriveAccountCapacityPct([
                { remainingPct: 80 },
                { remainingPct: 42 },
                { remainingPct: 91 },
            ]),
        ).toBe(42);
    });

    it('clamps remaining percentages into 0..100', () => {
        expect(deriveAccountCapacityPct([{ remainingPct: 140 }, { remainingPct: -20 }])).toBe(0);
        expect(deriveAccountCapacityPct([{ remainingPct: 140 }])).toBe(100);
    });

    it('ignores non-finite rows and returns null when nothing is usable', () => {
        expect(
            deriveAccountCapacityPct([
                { remainingPct: Number.NaN },
                { remainingPct: 55 },
            ]),
        ).toBe(55);
        expect(deriveAccountCapacityPct([{ remainingPct: Number.NaN }])).toBeNull();
    });

    it('returns null for an empty list', () => {
        expect(deriveAccountCapacityPct([])).toBeNull();
    });
});
