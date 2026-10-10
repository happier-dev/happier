import { describe, expect, it } from 'vitest';

import { createWitnessedResetWatch, detectWitnessedResets, type UsageWindowReading } from './usageWitnessedReset';

const HOUR = 3_600_000;
const reading = (key: string, resetAtMs: number | null, remainingFraction: number | null): UsageWindowReading => ({ key, resetAtMs, remainingFraction });

describe('witnessed reset', () => {
    it('is a window that was used up and is then read in a later cycle with room again', () => {
        const hit = [reading('claude:5h', 10 * HOUR, 0), reading('claude:week', 90 * HOUR, 0.4)];
        const after = [reading('claude:5h', 15 * HOUR, 1), reading('claude:week', 90 * HOUR, 0.38)];
        expect(detectWitnessedResets(hit, after).map((entry) => entry.key)).toEqual(['claude:5h']);
    });

    it('never celebrates a first read, a window that was not used up, or a reading that is unknown', () => {
        const after = [reading('claude:5h', 15 * HOUR, 1)];
        // Hydration: there is nothing before it to have witnessed.
        expect(detectWitnessedResets(null, after)).toEqual([]);
        // It had room left: a routine rollover is not a moment.
        expect(detectWitnessedResets([reading('claude:5h', 10 * HOUR, 0.2)], after)).toEqual([]);
        // Unknown before or after is not "used up" or "full".
        expect(detectWitnessedResets([reading('claude:5h', 10 * HOUR, null)], after)).toEqual([]);
        expect(detectWitnessedResets([reading('claude:5h', 10 * HOUR, 0)], [reading('claude:5h', 15 * HOUR, null)])).toEqual([]);
        // Still the same cycle (a banked reset is not applied, the read merely refreshed).
        expect(detectWitnessedResets([reading('claude:5h', 10 * HOUR, 0)], [reading('claude:5h', 10 * HOUR, 0)])).toEqual([]);
        // The reset moved but nothing came back.
        expect(detectWitnessedResets([reading('claude:5h', 10 * HOUR, 0)], [reading('claude:5h', 15 * HOUR, 0)])).toEqual([]);
    });

    it('fires once per reset, and forgets what it saw while nobody was looking', () => {
        const watch = createWitnessedResetWatch();
        const hit = [reading('claude:5h', 10 * HOUR, 0)];
        const after = [reading('claude:5h', 15 * HOUR, 1)];
        expect(watch.observe(hit, true)).toEqual([]);
        expect(watch.observe(after, true).map((entry) => entry.key)).toEqual(['claude:5h']);
        // The same facts again (a re-render, a second mounted body) do not replay it.
        expect(watch.observe(after, true)).toEqual([]);

        // Used up again, then the app is hidden across the reset: coming back is a first read.
        const hitAgain = [reading('claude:5h', 15 * HOUR, 0)];
        const later = [reading('claude:5h', 20 * HOUR, 1)];
        expect(watch.observe(hitAgain, true)).toEqual([]);
        expect(watch.observe(hitAgain, false)).toEqual([]);
        expect(watch.observe(later, true)).toEqual([]);
    });
});
