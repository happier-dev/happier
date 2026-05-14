import { darkTheme, lightTheme, type Theme } from '@/theme';

import type { CanonicalBaseThemeId, ThemeProfileMode } from './themeProfileTypes';

export const CANONICAL_BASE_THEME_IDS = ['light', 'dark'] as const satisfies readonly CanonicalBaseThemeId[];

export const baseThemeCatalog: Readonly<Record<ThemeProfileMode, Theme>> = {
    light: lightTheme,
    dark: darkTheme,
};

export const getBaseTheme = (mode: ThemeProfileMode): Theme => baseThemeCatalog[mode];
