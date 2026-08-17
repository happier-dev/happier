import { describe, expect, it } from 'vitest';

import { ARRIVAL_SECONDS, arrivalGesture } from './arrivalGesture';

/**
 * §2.4a — `connecting` / `acquiring_mic` get **one bounded gesture**, not
 * respiration.
 *
 * "Bounded" is the whole contract: a gesture that repeats is respiration under
 * another name, and respiration before the microphone is open is the lie this
 * whole correction exists to remove. So the curve is pinned as a curve — it
 * rises once, comes back to zero, and stays there for as long as the connect
 * takes.
 */
describe('arrivalGesture', () => {
    it('is at rest before it starts and after it ends', () => {
        expect(arrivalGesture(-1)).toBe(0);
        expect(arrivalGesture(0)).toBe(0);
        expect(arrivalGesture(ARRIVAL_SECONDS)).toBe(0);
        // A slow connect must not keep the planet moving: this is the assertion
        // that separates a gesture from a loop.
        expect(arrivalGesture(ARRIVAL_SECONDS * 4)).toBe(0);
        expect(arrivalGesture(600)).toBe(0);
    });

    it('rises to a single peak and returns, without a second swell', () => {
        const samples: number[] = [];
        for (let i = 0; i <= 200; i += 1) samples.push(arrivalGesture((i / 200) * ARRIVAL_SECONDS));

        const peak = Math.max(...samples);
        expect(peak).toBeGreaterThan(0.99);
        expect(peak).toBeLessThanOrEqual(1);

        // Exactly one direction change: up to the peak, then down. A sine-like
        // term would register several.
        const peakIndex = samples.indexOf(peak);
        let reversals = 0;
        for (let i = 1; i < samples.length - 1; i += 1) {
            const rising = samples[i]! > samples[i - 1]!;
            const nextRising = samples[i + 1]! > samples[i]!;
            if (rising !== nextRising) reversals += 1;
        }
        expect(reversals).toBe(1);
        // Front-loaded: it arrives quickly and settles slowly, like the breath's
        // own inhale/exhale asymmetry rather than a symmetric pulse.
        expect(peakIndex).toBeLessThan(samples.length / 2);
    });

    it('never overshoots the breath it precedes', () => {
        for (let i = 0; i <= 100; i += 1) {
            const value = arrivalGesture((i / 100) * ARRIVAL_SECONDS);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
        }
    });
});
