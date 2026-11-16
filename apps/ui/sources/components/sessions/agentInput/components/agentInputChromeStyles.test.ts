import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from '@/theme';

import { resolveAgentInputPanelLayoutStyle, resolveAgentInputPanelStyle } from './agentInputChromeStyles';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';

describe('agent input panel chrome', () => {
    it('shares the nested content coat between the live composer and its static previews', () => {
        expect(resolveAgentInputPanelStyle(lightTheme).backgroundColor).toBe(glassSurfaceBackgroundColor(lightTheme.colors.input.background, 'card'));
    });
    it('draws the composer in one even hairline, with no darker bottom lip or lighter top line (owner, 2026-10-15)', () => {
        for (const theme of [lightTheme, darkTheme]) {
            const style: Record<string, unknown> = resolveAgentInputPanelLayoutStyle(theme);
            for (const side of ['Top', 'Bottom']) {
                expect(style[`border${side}Color`] ?? style.borderColor).toBe(style.borderColor);
                expect(style[`border${side}Width`] ?? style.borderWidth).toBe(style.borderWidth);
            }
        }
    });
    it('draws no edge line around the light composer, where its fill and cast shadow carry the edge, and keeps dark\'s glass line (owner, 2026-11-16)', () => {
        expect(resolveAgentInputPanelLayoutStyle(lightTheme).borderWidth ?? 0).toBe(0);
        expect(resolveAgentInputPanelLayoutStyle(darkTheme).borderWidth).toBeGreaterThan(0);
    });
    it('rounds the composer panel with the theme composer radius', () => {
        const theme = { ...lightTheme, parts: { ...lightTheme.parts, composer: { ...lightTheme.parts.composer, radius: 37 } } };

        expect(resolveAgentInputPanelStyle(theme).borderRadius).toBe(37);
        expect(resolveAgentInputPanelStyle(lightTheme).borderRadius).toBe(lightTheme.parts.composer.radius);
    });
});
