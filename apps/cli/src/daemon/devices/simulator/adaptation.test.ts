import { describe, expect, it } from 'vitest';

import {
    createSimulatorBitrateAdaptationController,
    DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS,
} from './adaptation';

describe('createSimulatorBitrateAdaptationController', () => {
    it('starts at the configured initial bitrate and surfaces it as the current target', () => {
        const controller = createSimulatorBitrateAdaptationController({
            initialBitrateBps: 4_000_000,
            minBitrateBps: 500_000,
            maxBitrateBps: 8_000_000,
        });

        expect(controller.currentTargetBitrateBps()).toBe(4_000_000);
    });

    it('reduces target bitrate on sustained backpressure and clamps to the floor', () => {
        const controller = createSimulatorBitrateAdaptationController({
            initialBitrateBps: 4_000_000,
            minBitrateBps: 1_000_000,
            maxBitrateBps: 8_000_000,
        });

        // Sustained backpressure (frames dropped / cap breaches) must pull the target DOWN.
        const first = controller.observe({
            nowMs: 1_000,
            deliveredBytes: 100_000,
            droppedBytes: 80_000,
            backpressure: true,
        });
        expect(first.targetBitrateBps).toBeLessThan(4_000_000);

        // Repeated backpressure keeps reducing but never below the floor.
        let last = first.targetBitrateBps;
        for (let tick = 2; tick < 40; tick += 1) {
            const result = controller.observe({
                nowMs: tick * 1_000,
                deliveredBytes: 50_000,
                droppedBytes: 200_000,
                backpressure: true,
            });
            expect(result.targetBitrateBps).toBeLessThanOrEqual(last);
            expect(result.targetBitrateBps).toBeGreaterThanOrEqual(1_000_000);
            last = result.targetBitrateBps;
        }
        expect(last).toBe(1_000_000);
    });

    it('recovers target bitrate after a sustained clean window and clamps to the ceiling', () => {
        const controller = createSimulatorBitrateAdaptationController({
            initialBitrateBps: 2_000_000,
            minBitrateBps: 500_000,
            maxBitrateBps: 6_000_000,
        });

        let last = controller.currentTargetBitrateBps();
        for (let tick = 1; tick < 60; tick += 1) {
            const result = controller.observe({
                nowMs: tick * 1_000,
                deliveredBytes: 250_000,
                droppedBytes: 0,
                backpressure: false,
            });
            expect(result.targetBitrateBps).toBeGreaterThanOrEqual(last);
            expect(result.targetBitrateBps).toBeLessThanOrEqual(6_000_000);
            last = result.targetBitrateBps;
        }
        expect(last).toBe(6_000_000);
    });

    it('only signals a quality change when the target crosses the significant-change threshold', () => {
        const controller = createSimulatorBitrateAdaptationController({
            initialBitrateBps: 4_000_000,
            minBitrateBps: 1_000_000,
            maxBitrateBps: 8_000_000,
        });

        // A single mild-clean tick must not thrash a restart for a sub-threshold delta.
        const mild = controller.observe({
            nowMs: 1_000,
            deliveredBytes: 200_000,
            droppedBytes: 0,
            backpressure: false,
        });
        expect(mild.shouldApply).toBe(false);

        // A hard backpressure tick crosses the threshold and requests an apply.
        const hard = controller.observe({
            nowMs: 2_000,
            deliveredBytes: 10_000,
            droppedBytes: 500_000,
            backpressure: true,
        });
        expect(hard.shouldApply).toBe(true);
        expect(hard.targetBitrateBps).toBeLessThan(4_000_000);
    });

    it('NAT-6: increases ADDITIVELY (fixed linear step), not geometrically (MIMD)', () => {
        const controller = createSimulatorBitrateAdaptationController({
            initialBitrateBps: 1_000_000,
            minBitrateBps: 1_000_000,
            maxBitrateBps: 11_000_000,
        });
        // span = 10_000_000, additive step = 10% of span = 1_000_000 bps per recovery.
        const expectedStep = 1_000_000;

        const increases: number[] = [];
        let previous = controller.currentTargetBitrateBps();
        for (let tick = 1; tick < 40; tick += 1) {
            const result = controller.observe({
                nowMs: tick * 1_000,
                deliveredBytes: 250_000,
                droppedBytes: 0,
                backpressure: false,
            });
            if (result.targetBitrateBps !== previous) {
                increases.push(result.targetBitrateBps - previous);
                previous = result.targetBitrateBps;
            }
        }

        expect(increases.length).toBeGreaterThan(1);
        // Every increase that did not hit the ceiling clamp is exactly the fixed additive step.
        // A geometric (MIMD `* 1.1`) ramp would produce strictly GROWING increments instead.
        const nonClampedSteps = increases.filter((step) => step === expectedStep);
        expect(nonClampedSteps.length).toBeGreaterThanOrEqual(increases.length - 1);
        for (const step of increases) {
            expect(step).toBeLessThanOrEqual(expectedStep);
        }
    });

    it('NAT-6: resets the clean-window streak after each increase (no runaway ramp per window)', () => {
        const controller = createSimulatorBitrateAdaptationController({
            initialBitrateBps: 2_000_000,
            minBitrateBps: 1_000_000,
            maxBitrateBps: 11_000_000,
        });

        // 3 clean windows trigger the first increase; the streak then resets.
        let result = controller.observe({ nowMs: 1_000, deliveredBytes: 1, droppedBytes: 0, backpressure: false });
        expect(result.targetBitrateBps).toBe(2_000_000);
        result = controller.observe({ nowMs: 2_000, deliveredBytes: 1, droppedBytes: 0, backpressure: false });
        expect(result.targetBitrateBps).toBe(2_000_000);
        result = controller.observe({ nowMs: 3_000, deliveredBytes: 1, droppedBytes: 0, backpressure: false });
        const afterFirstIncrease = result.targetBitrateBps;
        expect(afterFirstIncrease).toBe(3_000_000); // 2M + 1M additive step

        // The VERY NEXT clean window must NOT increase again — the streak was reset to 0.
        result = controller.observe({ nowMs: 4_000, deliveredBytes: 1, droppedBytes: 0, backpressure: false });
        expect(result.targetBitrateBps).toBe(afterFirstIncrease);
        result = controller.observe({ nowMs: 5_000, deliveredBytes: 1, droppedBytes: 0, backpressure: false });
        expect(result.targetBitrateBps).toBe(afterFirstIncrease);
        // Only after 3 more clean windows does the next additive step land.
        result = controller.observe({ nowMs: 6_000, deliveredBytes: 1, droppedBytes: 0, backpressure: false });
        expect(result.targetBitrateBps).toBe(4_000_000);
    });

    it('exposes sane default bounds', () => {
        expect(DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS.minBitrateBps).toBeGreaterThan(0);
        expect(DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS.maxBitrateBps)
            .toBeGreaterThan(DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS.minBitrateBps);
        expect(DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS.initialBitrateBps)
            .toBeGreaterThanOrEqual(DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS.minBitrateBps);
        expect(DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS.initialBitrateBps)
            .toBeLessThanOrEqual(DEFAULT_SIMULATOR_BITRATE_ADAPTATION_BOUNDS.maxBitrateBps);
    });
});
