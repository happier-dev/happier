import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from './theme';
import { darkTheme as darkThemeJs, lightTheme as lightThemeJs } from './theme.js';

describe('theme JS compatibility copy', () => {
    it('matches key light theme tokens from the TypeScript source', () => {
        expect(lightThemeJs.colors.feed.card.background).toBe(lightTheme.colors.feed.card.background);
        expect(lightThemeJs.colors.groupped).toEqual(lightTheme.colors.groupped);
        expect(lightThemeJs.colors.switch).toEqual(lightTheme.colors.switch);
    });

    it('matches key dark theme tokens from the TypeScript source', () => {
        expect(darkThemeJs.colors.feed.card.background).toBe(darkTheme.colors.feed.card.background);
        expect(darkThemeJs.colors.groupped).toEqual(darkTheme.colors.groupped);
        expect(darkThemeJs.colors.switch).toEqual(darkTheme.colors.switch);
    });
});
