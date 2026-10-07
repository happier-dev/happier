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
        // A light sheet with no border still gets a visible lip.
        expect(lightTheme.colors.border.surface).toBe('transparent');
        expect(alpha(lightTheme.colors.edge.surface)).toBeGreaterThan(0);
        // The rim's corner is the theme's own ink: lighter on dark, a breath darker on light, never white.
        expect(luminance(darkTheme.colors.edge.rimHi, darkGround)).toBeGreaterThan(Color(darkGround).luminosity());
        expect(luminance(lightTheme.colors.edge.rimHi, lightGround)).toBeLessThan(Color(lightGround).luminosity());
        // Dark controls stand on a lifted fill; light ones on the page.
        expect(darkTheme.colors.edge.fill).not.toBe(darkTheme.colors.surface.base);
        expect(lightTheme.colors.edge.fill).toBe(lightTheme.colors.surface.base);
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
