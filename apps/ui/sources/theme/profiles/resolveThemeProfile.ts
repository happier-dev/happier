import type { Theme } from '@/theme';

import { getBaseTheme } from './baseThemeCatalog';
import { deriveThemeColors } from './deriveThemeColors';
import { isValidThemeProfileColorValue } from './themeProfileColorValidation';
import { getThemeProfileTokenDefinition } from './themeProfileTokenRegistry';
import { setThemeProfilePathValue } from './themeProfilePathAccess';
import type { ThemeProfileMode, ThemeProfileV1 } from './themeProfileTypes';

const MAX_EFFECTIVE_THEME_CACHE_ENTRIES = 16;

type ResolveThemeProfileInput = Readonly<{
    mode: ThemeProfileMode;
    profile: ThemeProfileV1 | null;
}>;

const effectiveThemeCache = new Map<string, Theme>();

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

const cloneValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(cloneValue);
    }

    if (isRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
    }

    return value;
};

const cloneTheme = (theme: Theme): Theme => cloneValue(theme) as Theme;

const overrideHash = (overrides: ThemeProfileV1['overrides'][ThemeProfileMode]): string => (
    JSON.stringify(Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right)))
);

const getCacheKey = (mode: ThemeProfileMode, profile: ThemeProfileV1): string => [
    mode,
    profile.base[mode],
    profile.id,
    profile.updatedAt,
    overrideHash(profile.overrides[mode]),
].join('|');

const rememberEffectiveTheme = (key: string, theme: Theme): Theme => {
    effectiveThemeCache.set(key, theme);
    if (effectiveThemeCache.size > MAX_EFFECTIVE_THEME_CACHE_ENTRIES) {
        const oldestKey = effectiveThemeCache.keys().next().value;
        if (typeof oldestKey === 'string') {
            effectiveThemeCache.delete(oldestKey);
        }
    }
    return theme;
};

export const clearEffectiveThemeCache = (): void => {
    effectiveThemeCache.clear();
};

export const resolveThemeProfile = ({ mode, profile }: ResolveThemeProfileInput): Theme => {
    const baseTheme = getBaseTheme(mode);
    if (!profile) {
        return baseTheme;
    }

    const cacheKey = getCacheKey(mode, profile);
    const cachedTheme = effectiveThemeCache.get(cacheKey);
    if (cachedTheme) {
        return cachedTheme;
    }

    let nextColors = cloneTheme(baseTheme).colors;

    for (const [tokenId, value] of Object.entries(profile.overrides[mode])) {
        const definition = getThemeProfileTokenDefinition(tokenId);
        if (!definition || !isValidThemeProfileColorValue(value)) {
            continue;
        }

        nextColors = setThemeProfilePathValue(nextColors, definition.path, value);
    }

    return rememberEffectiveTheme(cacheKey, deriveThemeColors({ ...baseTheme, colors: nextColors }, baseTheme));
};
