import Color from 'color';
import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from './index';
import { resolveThemeProfile } from './profiles/resolveThemeProfile';
import type { ThemeProfileV1 } from './profiles/themeProfileTypes';
import { compositeRaisedEdgeColor } from './raisedEdge';

const alpha = (color: string) => Color(color).alpha();
const luminance = (color: string, over: string) => Color(compositeRaisedEdgeColor(over, color)).luminosity();

function profile(mode: 'light' | 'dark', overrides: Record<string, string>): ThemeProfileV1 {
    return {
        schemaVersion: 1,
        id: `edge-${mode}-${Object.keys(overrides).join('-')}`,
        name: 'Edge',
        createdAt: '2026-10-07T00:00:00.000Z',
        updatedAt: '2026-10-07T00:00:00.000Z',
        base: { light: 'light', dark: 'dark' },
        overrides: { light: mode === 'light' ? overrides : {}, dark: mode === 'dark' ? overrides : {} },
    };
}

describe('raised edge colours', () => {
    it('derives one translucent ink overlay independent of the surface underneath', () => {
        const light = lightTheme.colors.edge.finishGradient;
        const dark = darkTheme.colors.edge.finishGradient;
        expect(light?.locations).toEqual([0.3, 1]);
        expect(dark?.locations).toEqual([0, 0.7]);
        expect(light?.colors.map(alpha)).toEqual([0, 0.024]);
        expect(dark?.colors.map(alpha)).toEqual([0.045, 0.01]);
        expect(lightTheme.colors.edge.primaryFinishGradient?.colors.map(alpha)).toEqual([0.14, 0]);
        expect(darkTheme.colors.edge.primaryFinishGradient?.colors.map(alpha)).toEqual([0, 0.12]);
        expect(lightTheme.colors.edge.secondaryFinishGradient?.colors.map(alpha)).toEqual([0, 0.025]);
        expect(darkTheme.colors.edge.secondaryFinishGradient?.colors.map(alpha)).toEqual([0.04, 0]);
        for (const theme of [lightTheme, darkTheme]) {
            const fills = theme.colors.button.primary.gradient?.colors ?? [theme.colors.button.primary.background];
            for (const fill of fills) {
                for (const stop of theme.colors.edge.primaryFinishGradient!.colors) {
                    const paint = compositeRaisedEdgeColor(fill, stop);
                    expect(Color(paint).contrast(Color(theme.colors.button.primary.tint))).toBeGreaterThanOrEqual(4.5);
                }
            }
        }
        // A glass coat keeps the backdrop: the finish adds low-alpha ink, never an opaque fill.
        const glass = 'rgba(240, 240, 240, 0.3)';
        expect(alpha(compositeRaisedEdgeColor(glass, light!.colors[1]))).toBeCloseTo(0.317, 3);
        expect(alpha(compositeRaisedEdgeColor(glass, dark!.colors[0]))).toBeCloseTo(0.045 + 0.3 * (1 - 0.045), 2);
    });

    it('keeps existing paint exact when finish strength is transparent and honors profile ink without clamping', () => {
        const flat = resolveThemeProfile({ mode: 'light', profile: profile('light', { 'effect.surfaceFinish': 'transparent' }) });
        expect(flat.colors.edge.finishGradient).toBeNull();
        expect(flat.colors.edge.primaryFinishGradient).toBeNull();
        expect(flat.colors.edge.secondaryFinishGradient).toBeNull();
        const { finishGradient, primaryFinishGradient, secondaryFinishGradient, ...existingPaint } = flat.colors.edge;
        const { finishGradient: ignoredFinish, primaryFinishGradient: ignoredPrimary, secondaryFinishGradient: ignoredSecondary, ...oldPaint } = lightTheme.colors.edge;
        expect(existingPaint).toEqual(oldPaint);
        const tinted = resolveThemeProfile({ mode: 'dark', profile: profile('dark', { 'text.primary': '#A9B1D6' }) });
        expect(tinted.colors.edge.finishGradient?.colors[0]).toBe('rgba(169, 177, 214, 0.045)');
        const strong = resolveThemeProfile({ mode: 'light', profile: profile('light', { 'effect.surfaceFinish': 'rgba(122, 162, 247, 0.5)' }) });
        expect(strong.colors.edge.finishGradient?.colors[1]).toBe('rgba(122, 162, 247, 0.5)');
    });

    it('composites the edge ink over the border as the eye sees it', () => {
        // white 6% over white 9% is one white at 1 - 0.94 × 0.91.
        expect(compositeRaisedEdgeColor('rgba(255,255,255,0.09)', 'rgba(255,255,255,0.06)')).toBe('rgba(255, 255, 255, 0.145)');
        // A transparent border leaves the ink alone; an unreadable border keeps the border.
        expect(compositeRaisedEdgeColor('transparent', 'rgba(0,0,0,0.04)')).toBe('rgba(0, 0, 0, 0.04)');
        expect(compositeRaisedEdgeColor('var(--x)', 'rgba(0,0,0,0.04)')).toBe('var(--x)');
    });

    it('raises every border role brighter on dark and darker on light, on the theme\'s own ground', () => {
        const darkGround = darkTheme.colors.surface.base;
        const lightGround = lightTheme.colors.surface.base;
        for (const role of ['default', 'surface', 'strong', 'modal'] as const) {
            expect(luminance(darkTheme.colors.edge[role], darkGround)).toBeGreaterThan(luminance(darkTheme.colors.border[role], darkGround));
            expect(luminance(lightTheme.colors.edge[role], lightGround)).toBeLessThan(luminance(lightTheme.colors.border[role], lightGround));
        }
        // A light sheet's ink border carries a visible lip.
        expect(alpha(lightTheme.colors.edge.surface)).toBeGreaterThan(alpha(lightTheme.colors.border.surface));
        // The rim's corner is the theme's own ink: lighter on dark, a breath darker on light, never white.
        expect(luminance(darkTheme.colors.edge.rimHi, darkGround)).toBeGreaterThan(Color(darkGround).luminosity());
        expect(luminance(lightTheme.colors.edge.rimHi, lightGround)).toBeLessThan(Color(lightGround).luminosity());
        // Dark controls stand on a lifted fill; light ones on the page.
        expect(darkTheme.colors.edge.fill).not.toBe(darkTheme.colors.surface.base);
        expect(lightTheme.colors.edge.fill).toBe(lightTheme.colors.surface.base);
    });

    it('layers dark surfaces by small steps of light — navigation < page < card < floating — and keeps one paper on light', () => {
        const step = (color: string) => luminance(color, darkTheme.colors.background.canvas);
        expect(step(darkTheme.colors.surface.base)).toBeGreaterThan(step(darkTheme.colors.background.canvas));
        expect(step(darkTheme.colors.edge.cardFill)).toBeGreaterThan(step(darkTheme.colors.surface.base));
        expect(step(darkTheme.colors.edge.floatingFill)).toBeGreaterThan(step(darkTheme.colors.edge.cardFill));
        expect(lightTheme.colors.edge.cardFill).toBe(lightTheme.colors.surface.base);
        expect(lightTheme.colors.edge.floatingFill).toBe(lightTheme.colors.surface.base);
    });

    it('re-derives a theme profile\'s edges from its own ink and borders, and keeps an ink the profile set', () => {
        const tinted = resolveThemeProfile({ mode: 'dark', profile: profile('dark', { 'text.primary': '#A9B1D6', 'border.strong': 'rgba(122,162,247,0.20)' }) });
        expect(tinted.colors.effect.surfaceHighlight).toBe('rgba(169, 177, 214, 0.06)');
        expect(tinted.colors.edge.strong).toBe(compositeRaisedEdgeColor('rgba(122,162,247,0.20)', 'rgba(169, 177, 214, 0.06)'));

        const flat = resolveThemeProfile({ mode: 'light', profile: profile('light', { 'effect.surfaceHighlight': 'transparent' }) });
        expect(flat.colors.effect.surfaceHighlight).toBe('transparent');
        expect(flat.colors.edge.strong).toBe(compositeRaisedEdgeColor(flat.colors.border.strong, 'transparent'));
    });
});
