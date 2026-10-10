import { describe, expect, it } from 'vitest';

import { lightTheme } from '@/theme';

import { resolveAgentInputPanelStyle } from './agentInputChromeStyles';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';

describe('agent input panel chrome', () => {
    it('shares the nested content coat between the live composer and its static previews', () => {
        expect(resolveAgentInputPanelStyle(lightTheme).backgroundColor).toBe(glassSurfaceBackgroundColor(lightTheme.colors.input.background, 'content', true));
    });
    it('rounds the composer panel with the theme composer radius', () => {
        const theme = { ...lightTheme, parts: { ...lightTheme.parts, composer: { ...lightTheme.parts.composer, radius: 37 } } };

        expect(resolveAgentInputPanelStyle(theme).borderRadius).toBe(37);
        expect(resolveAgentInputPanelStyle(lightTheme).borderRadius).toBe(lightTheme.parts.composer.radius);
    });
});
