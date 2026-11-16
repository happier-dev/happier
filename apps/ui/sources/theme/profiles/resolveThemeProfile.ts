import type { Theme } from '@/theme';

import { getBaseTheme } from './baseThemeCatalog';
import { deriveThemeColors } from './deriveThemeColors';
import { deriveThemeSeedColors } from './deriveThemeSeedColors';
import { resolveThemeProfileAssetAppearance } from './themeProfileAssetAppearance';
import { applyThemeStyleScales, resolveThemeStyleScales } from '../themeStyleScales';
import { isValidThemeProfileColorValue } from './themeProfileColorValidation';
import { getThemeProfileTokenDefinition } from './themeProfileTokenRegistry';
import { setThemeProfilePathValue } from './themeProfilePathAccess';
import type { ThemeProfileMode, ThemeProfileV1 } from './themeProfileTypes';

const MAX_EFFECTIVE_THEME_CACHE_ENTRIES = 16;

type ResolveThemeProfileInput = Readonly<{
    mode: ThemeProfileMode;
    profile: Pick<ThemeProfileV1, 'overrides' | 'seeds' | 'assetAppearance' | 'style'> | null;
}>;

const effectiveThemeCache = new Map<string, Theme>();

const overrideHash = (overrides: ThemeProfileV1['overrides'][ThemeProfileMode]): string => (
    JSON.stringify(Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right)))
);

const getCacheKey = (mode: ThemeProfileMode, profile: NonNullable<ResolveThemeProfileInput['profile']>): string => [
    mode,
    overrideHash(profile.overrides[mode]),
    mode === resolveThemeProfileAssetAppearance(profile) ? JSON.stringify(profile.seeds) : '',
    JSON.stringify(profile.style),
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

    const seeds = mode === resolveThemeProfileAssetAppearance(profile) ? profile.seeds : undefined;
    let nextColors = seeds ? deriveThemeSeedColors(baseTheme, seeds) : baseTheme.colors;
    const explicitOverrides = new Set<string>();

    for (const [tokenId, value] of Object.entries(profile.overrides[mode])) {
        const definition = getThemeProfileTokenDefinition(tokenId);
        if (!definition || !isValidThemeProfileColorValue(value)) {
            continue;
        }

        nextColors = setThemeProfilePathValue(nextColors, definition.path, value);
        explicitOverrides.add(tokenId);
    }

    const resolved = seeds || explicitOverrides.size > 0
        ? deriveThemeColors({ ...baseTheme, colors: nextColors }, baseTheme, explicitOverrides) : baseTheme;
    return rememberEffectiveTheme(cacheKey, profile.style
        ? applyThemeStyleScales(resolved, resolveThemeStyleScales(profile.style)) : resolved);
};
