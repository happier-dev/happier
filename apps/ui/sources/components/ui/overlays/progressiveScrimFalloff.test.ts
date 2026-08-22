import { describe, expect, it } from 'vitest';

import { scrimFalloff, scrimMaskBand, scrimRamp } from './progressiveScrimFalloff';

describe('scrimFalloff', () => {
    it('is full strength at the anchored edge and clear at the far end', () => {
        expect(scrimFalloff(0)).toBe(1);
        expect(scrimFalloff(1)).toBe(0);
    });

    it('clears faster than a linear ramp, so the far half of the screen stays readable', () => {
        // The whole point of the scrim is that the list behind it can still be monitored while
        // typing. A linear ramp is still at half strength in the middle; this one is well under.
        expect(scrimFalloff(0.5)).toBeLessThan(0.5 * 0.75);
        expect(scrimFalloff(0.5)).toBeGreaterThan(0);
    });

    it('never inverts — strength only decreases with distance', () => {
        let previous = Number.POSITIVE_INFINITY;
        for (let step = 0; step <= 20; step += 1) {
            const value = scrimFalloff(step / 20);
            expect(value).toBeLessThanOrEqual(previous);
            previous = value;
        }
    });

    it('clamps outside the ramp instead of extrapolating past full or below clear', () => {
        expect(scrimFalloff(-1)).toBe(1);
        expect(scrimFalloff(2)).toBe(0);
    });
});

describe('scrimRamp', () => {
    it('emits enough stops to avoid banding a long soft gradient', () => {
        // Two stops is the tempting encoding and the one that bands. react-native-svg's
        // FeTurbulence is unimplemented at 15.x, so noise dithering is not an available fix.
        const ramp = scrimRamp();
        expect(ramp.locations.length).toBeGreaterThanOrEqual(8);
        expect(ramp.alphas).toHaveLength(ramp.locations.length);
    });

    it('spans the full ramp with monotonically increasing positions', () => {
        const ramp = scrimRamp(6);
        expect(ramp.locations[0]).toBe(0);
        expect(ramp.locations.at(-1)).toBe(1);
        for (let index = 1; index < ramp.locations.length; index += 1) {
            expect(ramp.locations[index]).toBeGreaterThan(ramp.locations[index - 1]!);
        }
    });

    it('samples the shared falloff rather than a second curve of its own', () => {
        const ramp = scrimRamp(5);
        ramp.locations.forEach((location, index) => {
            expect(ramp.alphas[index]).toBeCloseTo(scrimFalloff(location), 10);
        });
    });
});

describe('scrimMaskBand', () => {
    it('reveals each layer from the anchored edge out to its own band', () => {
        const band = scrimMaskBand(0, 3);
        expect(band.alphas[0]).toBe(1);
        expect(band.alphas.at(-1)).toBe(0);
    });

    it('gives later layers a wider reach, so blur weakens with distance instead of banding', () => {
        const first = scrimMaskBand(0, 3);
        const last = scrimMaskBand(2, 3);
        expect(last.locations[2]).toBeGreaterThan(first.locations[2]!);
    });

    it('ends every layer on a ramp rather than a step, so no seam shows where a radius stops', () => {
        // Each layer is revealed from the anchored edge to its own band and then falls away. What
        // must not happen is that fall being instantaneous: a hard mask edge is a visible line
        // across the scrim where one blur radius gives way to the next.
        for (let index = 0; index < 3; index += 1) {
            const band = scrimMaskBand(index, 3);
            const plateauEnd = band.locations[1]!;
            const fadeEnd = band.locations[2]!;
            expect(fadeEnd).toBeGreaterThan(plateauEnd);
        }
    });

    it('clamps an out-of-range layer index instead of producing an invalid gradient', () => {
        expect(scrimMaskBand(9, 3)).toEqual(scrimMaskBand(2, 3));
        expect(scrimMaskBand(-4, 3)).toEqual(scrimMaskBand(0, 3));
    });
});
