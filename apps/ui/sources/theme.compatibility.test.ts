import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from './theme';
import { darkTheme as darkThemeJs, lightTheme as lightThemeJs } from './theme.js';

describe('theme JS compatibility copy', () => {
    it('matches key light theme tokens from the TypeScript source', () => {
        expect(lightThemeJs.colors.feed.card.background).toBe(lightTheme.colors.feed.card.background);
        expect(lightThemeJs.colors.background.canvas).toBe(lightTheme.colors.background.canvas);
        expect(lightThemeJs.colors.surface.base).toEqual(lightTheme.colors.surface.base);
        expect(lightThemeJs.colors.border).toEqual(lightTheme.colors.border);
        expect(lightThemeJs.colors.chrome.header).toEqual(lightTheme.colors.chrome.header);
        expect(lightThemeJs.colors.effect.surfaceHighlight).toBe('transparent');
        expect('groupped' in lightThemeJs.colors).toBe(false);
        expect(lightThemeJs.colors.switch).toEqual(lightTheme.colors.switch);
    });

    it('matches key dark theme tokens from the TypeScript source', () => {
        expect(darkThemeJs.colors.feed.card.background).toBe(darkTheme.colors.feed.card.background);
        expect(darkThemeJs.colors.background.canvas).toBe(darkTheme.colors.background.canvas);
        expect(darkThemeJs.colors.surface.base).toEqual(darkTheme.colors.surface.base);
        expect(darkThemeJs.colors.border).toEqual(darkTheme.colors.border);
        expect(darkThemeJs.colors.chrome.header).toEqual(darkTheme.colors.chrome.header);
        expect(darkThemeJs.colors.effect.surfaceHighlight).toBe('transparent');
        expect('groupped' in darkThemeJs.colors).toBe(false);
        expect(darkThemeJs.colors.switch).toEqual(darkTheme.colors.switch);
    });
});
