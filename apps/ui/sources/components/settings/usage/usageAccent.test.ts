import { describe, expect, it } from 'vitest';

import { HAPPIER_SERIES_RAMP_ALPHAS as USAGE_SERIES_RAMP_ALPHAS } from '@happier-dev/plugin-ui/presentation';

import { getAgentIdentityColor, getNeutralAgentIdentityColor } from '@/agents/catalog/catalog';
import {
    createUsageAgentSeriesColor,
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

    it('mixes the ramp with a known paper into solid steps that keep their order', () => {
        const onPaper = { colors: { ...lightTheme.colors, surface: { base: '#FFFFFF' } } };
        expect(usageSeriesColor(onPaper, 0)).toBe('#2BACCC');
        expect(usageSeriesColor(onPaper, 1)).toBe('#51bbd5');
        const steps = Array.from({ length: 8 }, (_v, index) => usageSeriesColor(onPaper, index));
        expect(steps.every((step) => /^#[0-9a-fA-F]{6}$/.test(step))).toBe(true);
        expect(new Set(steps).size).toBe(8);
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

/** Spread between the strongest and weakest RGB channel: a grey or ink step has almost none, a hue has plenty. */
function chroma(color: string): number {
    const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
    if (!hex) throw new Error(`expected a solid #RRGGBB colour, got ${color}`);
    const value = parseInt(hex[1]!, 16);
    const channels = [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
    return Math.max(...channels) - Math.min(...channels);
}

// USAGE-ACCEPT 1118 #10: a ranked Agent chart drew every Agent without a catalog hue in the one neutral, so its
// five leaders and their Other could not be told apart. USAGE-ACCEPT 1121 #2: the ink steps that replaced the
// neutral drew the leading Agent (Muse, 21%) in near-black on light and near-white on dark, the loudest marks on
// the page. Every named Agent takes a hue; only the folded Other keeps the neutral.
describe('Agent series colours', () => {
    const themes = [
        { dark: false, colors: { text: { link: '#2BACCC', primary: '#18171C', secondary: '#6c6c70' }, surface: { base: '#FFFFFF' } } },
        { dark: true, colors: { text: { link: '#9EB9FF', primary: '#EFEFEF', secondary: '#8A817C' }, surface: { base: '#1B1919' } } },
    ] as const;
    for (const theme of themes) {
        const mode = theme.dark ? 'dark' : 'light';
        it(`keeps catalog hues and gives each hue-less leader a hue of its own, apart from the neutral (${mode})`, () => {
            const ids = ['muse', 'codex', 'opencode', 'grok', 'ohMyPi'];
            const color = createUsageAgentSeriesColor(theme, ['claude', ...ids]);
            const neutral = getNeutralAgentIdentityColor(theme);
            expect(color('claude')).toBe(getAgentIdentityColor(theme, 'claude'));
            const ranked = ids.map(color);
            expect(new Set([...ranked, neutral]).size).toBe(6);
            for (const hue of ranked) expect(chroma(hue)).toBeGreaterThan(48);
            // Asked again, an Agent keeps its colour.
            expect(color('muse')).toBe(ranked[0]);
        });

        it(`agrees across chart order and filter swatches when Agent hues collide (${mode})`, () => {
            const ids = ['acme-one', 'acme-three'];
            const read = createUsageAgentSeriesColor(theme, ids);
            const dailyColors = ids.map(read);
            const flowColors = [...ids].reverse().map(read).reverse();
            const swatches = ids.map(createUsageAgentSeriesColor(theme, [...ids].reverse()));

            expect(new Set(dailyColors).size).toBe(2);
            expect({ flow: flowColors, swatches }).toEqual({ flow: dailyColors, swatches: dailyColors });
            const next = createUsageAgentSeriesColor(theme, ['acme-three']);
            expect(next('acme-three')).toBe(dailyColors[0]);
            expect(read('acme-three')).toBe(dailyColors[1]);
            expect(read('')).toBe(getNeutralAgentIdentityColor(theme));
            expect(read('unknown')).toBe(getNeutralAgentIdentityColor(theme));
        });
    }
});
