import { describe, expect, it } from 'vitest';

import {
    USAGE_SERIES_RAMP_ALPHAS,
    usageMeterFill,
    usageSeriesColor,
    usageSignatureAccent,
    withUsageAccentAlpha,
} from './usageAccent';

// Structural slices of the real light/dark themes (theme/index.ts).
const lightTheme = { colors: { text: { link: '#2BACCC', secondary: '#6c6c70' } } } as const;
const darkTheme = { colors: { text: { link: '#9EB9FF', secondary: '#8A817C' } } } as const;

describe('usageAccent — the single usage palette owner (R-DESIGN D-1)', () => {
    it('signature accent is the theme link tone in both themes', () => {
        expect(usageSignatureAccent(lightTheme)).toBe('#2BACCC');
        expect(usageSignatureAccent(darkTheme)).toBe('#9EB9FF');
    });

    it('pins the ordered tonal ramp: full accent first, strictly decreasing legible steps', () => {
        expect(USAGE_SERIES_RAMP_ALPHAS[0]).toBe(1);
        for (let i = 1; i < USAGE_SERIES_RAMP_ALPHAS.length; i += 1) {
            expect(USAGE_SERIES_RAMP_ALPHAS[i]!).toBeLessThan(USAGE_SERIES_RAMP_ALPHAS[i - 1]!);
        }
        expect(USAGE_SERIES_RAMP_ALPHAS[USAGE_SERIES_RAMP_ALPHAS.length - 1]!).toBeGreaterThanOrEqual(0.2);
    });

    it('series colors are alpha steps of the ONE accent, never a different hue', () => {
        expect(usageSeriesColor(lightTheme, 0)).toBe('#2BACCC');
        expect(usageSeriesColor(lightTheme, 1)).toBe('rgba(43, 172, 204, 0.82)');
        expect(usageSeriesColor(darkTheme, 2)).toBe('rgba(158, 185, 255, 0.68)');
        // Indexes past the ramp clamp to the last step (still the same hue).
        expect(usageSeriesColor(lightTheme, 99)).toBe('rgba(43, 172, 204, 0.22)');
        expect(usageSeriesColor(lightTheme, -1)).toBe('#2BACCC');
    });

    it('carries at least 8 ordered steps so 8-category legends never wrap (D-6)', () => {
        // The context-gauge popover legend renders up to 8 categories; the ramp
        // must supply 8 DISTINCT ordered tones so no two categories collide and
        // the palette never wraps back to the signature accent.
        expect(USAGE_SERIES_RAMP_ALPHAS.length).toBeGreaterThanOrEqual(8);
        const firstEight = Array.from({ length: 8 }, (_v, index) => usageSeriesColor(lightTheme, index));
        expect(new Set(firstEight).size).toBe(8);
        // No wrap: none of steps 1..7 re-uses step 0 (the full signature accent).
        for (let i = 1; i < 8; i += 1) {
            expect(firstEight[i]).not.toBe(firstEight[0]);
        }
    });

    it('meter fill is monochrome neutral unless the row is emphasized', () => {
        expect(usageMeterFill(lightTheme, false)).toBe('#6c6c70');
        expect(usageMeterFill(lightTheme, true)).toBe('#2BACCC');
        expect(usageMeterFill(darkTheme, false)).toBe('#8A817C');
        expect(usageMeterFill(darkTheme, true)).toBe('#9EB9FF');
    });

    it('alpha helper converts 6-digit hex and passes through non-hex inputs', () => {
        expect(withUsageAccentAlpha('#2BACCC', 0.5)).toBe('rgba(43, 172, 204, 0.5)');
        expect(withUsageAccentAlpha('rgba(1, 2, 3, 0.4)', 0.5)).toBe('rgba(1, 2, 3, 0.4)');
        expect(withUsageAccentAlpha('#2BACCC', 2)).toBe('rgba(43, 172, 204, 1)');
    });
});
