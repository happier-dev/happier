import { describe, expect, it } from 'vitest';

import {
    CONTEXT_USAGE_DANGER_THRESHOLD_PCT,
    CONTEXT_USAGE_WARN_THRESHOLD_PCT,
    GAUGE_HAPTIC_THRESHOLDS_PCT,
    clampUsedPct,
    crossedHapticThreshold,
    resolveUsageTone,
    ringGeometry,
    sweepDashOffset,
    usageToneToTokenUsageTone,
} from './gaugeMath';

describe('gaugeMath', () => {
    describe('clampUsedPct', () => {
        it('clamps into [0, 100] and zeroes non-finite input', () => {
            expect(clampUsedPct(-5)).toBe(0);
            expect(clampUsedPct(0)).toBe(0);
            expect(clampUsedPct(42.5)).toBe(42.5);
            expect(clampUsedPct(120)).toBe(100);
            expect(clampUsedPct(Number.NaN)).toBe(0);
            expect(clampUsedPct(Number.POSITIVE_INFINITY)).toBe(100);
        });
    });

    describe('resolveUsageTone', () => {
        // Thresholds mirror contextWarning.ts: remaining ≤5% → danger, ≤10% → warn.
        it('matches the contextWarning thresholds expressed as used-pct', () => {
            expect(CONTEXT_USAGE_WARN_THRESHOLD_PCT).toBe(90);
            expect(CONTEXT_USAGE_DANGER_THRESHOLD_PCT).toBe(95);
        });

        it('maps pct to ok/warn/danger', () => {
            expect(resolveUsageTone(0)).toBe('ok');
            expect(resolveUsageTone(89.9)).toBe('ok');
            expect(resolveUsageTone(90)).toBe('warn');
            expect(resolveUsageTone(94.9)).toBe('warn');
            expect(resolveUsageTone(95)).toBe('danger');
            expect(resolveUsageTone(100)).toBe('danger');
            expect(resolveUsageTone(150)).toBe('danger');
        });
    });

    describe('usageToneToTokenUsageTone', () => {
        it('maps the gauge tone onto the canonical TokenUsageTone vocabulary', () => {
            expect(usageToneToTokenUsageTone('ok')).toBe('neutral');
            expect(usageToneToTokenUsageTone('warn')).toBe('warning');
            expect(usageToneToTokenUsageTone('danger')).toBe('critical');
        });
    });

    describe('ringGeometry / sweepDashOffset', () => {
        it('computes radius and circumference for a stroke-inset ring', () => {
            const geo = ringGeometry(20, 1.5);
            expect(geo.radius).toBeCloseTo((20 - 1.5) / 2);
            expect(geo.circumference).toBeCloseTo(2 * Math.PI * geo.radius);
        });

        it('maps pct to dash offset (0% = full offset, 100% = zero offset)', () => {
            const { circumference } = ringGeometry(20, 1.5);
            expect(sweepDashOffset(circumference, 0)).toBeCloseTo(circumference);
            expect(sweepDashOffset(circumference, 50)).toBeCloseTo(circumference / 2);
            expect(sweepDashOffset(circumference, 100)).toBe(0);
            expect(sweepDashOffset(circumference, 130)).toBe(0);
        });
    });

    describe('crossedHapticThreshold', () => {
        it('exposes the 75/90 haptic thresholds', () => {
            expect([...GAUGE_HAPTIC_THRESHOLDS_PCT]).toEqual([75, 90]);
        });

        it('detects an upward crossing and returns the highest threshold crossed', () => {
            expect(crossedHapticThreshold(70, 80)).toBe(75);
            expect(crossedHapticThreshold(74.9, 75)).toBe(75);
            expect(crossedHapticThreshold(80, 92)).toBe(90);
            expect(crossedHapticThreshold(60, 95)).toBe(90);
        });

        it('returns null with no crossing, downward movement, or same side', () => {
            expect(crossedHapticThreshold(10, 50)).toBeNull();
            expect(crossedHapticThreshold(80, 85)).toBeNull();
            expect(crossedHapticThreshold(92, 96)).toBeNull();
            expect(crossedHapticThreshold(80, 70)).toBeNull();
            expect(crossedHapticThreshold(95, 60)).toBeNull();
        });
    });
});
