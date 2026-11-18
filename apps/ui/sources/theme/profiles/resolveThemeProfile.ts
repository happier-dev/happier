import type { Theme } from '@/theme';

import { getBaseTheme } from './baseThemeCatalog';
import { deriveThemeColorsWithPaint, type ResolvedThemePaints } from './deriveThemeColors';
import { deriveThemeSeedColors } from './deriveThemeSeedColors';
import { resolveThemeProfileAssetAppearance } from './themeProfileAssetAppearance';
import { applyThemeStyleScales, resolveThemeStyleScales } from '../themeStyleScales';
import { isValidThemeProfileColorValue } from './themeProfileColorValidation';
import { getThemeProfileTokenDefinition } from './themeProfileTokenRegistry';
import { setThemeProfilePathValue } from './themeProfilePathAccess';
import type { ThemeProfileMode, ThemeProfileV1 } from './themeProfileTypes';

type ResolveThemeProfileInput = Readonly<{
    mode: ThemeProfileMode;
    profile: Pick<ThemeProfileV1, 'overrides' | 'seeds' | 'assetAppearance' | 'style'> | null;
}>;

export type ResolvedThemeProfile = Readonly<{ theme: Theme; paint: ResolvedThemePaints }>;

const overrideHash = (overrides: ThemeProfileV1['overrides'][ThemeProfileMode]): string => (
    JSON.stringify(Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right)))
);

const getCacheKey = (mode: ThemeProfileMode, profile: NonNullable<ResolveThemeProfileInput['profile']>): string => [
    mode,
    overrideHash(profile.overrides[mode]),
    mode === resolveThemeProfileAssetAppearance(profile) ? JSON.stringify(profile.seeds) : '',
    JSON.stringify(profile.style),
].join('|');

export const resolveUncachedThemeProfile = ({ mode, profile }: ResolveThemeProfileInput): ResolvedThemeProfile => {
    const baseTheme = getBaseTheme(mode);
    if (!profile) {
        return { theme: baseTheme, paint: deriveThemeColorsWithPaint(baseTheme, baseTheme).paint };
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

    const resolved = deriveThemeColorsWithPaint({ ...baseTheme, colors: nextColors }, baseTheme, explicitOverrides);
    const theme = seeds || explicitOverrides.size > 0 ? resolved.theme : baseTheme;
    return { theme: profile.style ? applyThemeStyleScales(theme, resolveThemeStyleScales(profile.style)) : theme,
        paint: resolved.paint };
};

/** Each consumer retains its current palette per mode; gallery reads cannot evict runtime identity. */
export function createThemeProfileResolver(): Readonly<{
    resolve(input: ResolveThemeProfileInput): Theme;
    resolveWithPaint(input: ResolveThemeProfileInput): ResolvedThemeProfile;
    clear(): void;
}> {
    const current = new Map<ThemeProfileMode, Readonly<{ key: string; result: ResolvedThemeProfile }>>();
    const resolveWithPaint = (input: ResolveThemeProfileInput): ResolvedThemeProfile => {
        const key = input.profile ? getCacheKey(input.mode, input.profile) : '';
        const cached = current.get(input.mode);
        if (cached?.key === key) return cached.result;
        const result = resolveUncachedThemeProfile(input);
        current.set(input.mode, { key, result });
        return result;
    };
    return {
        resolve(input) {
            if (!input.profile) return getBaseTheme(input.mode);
            return resolveWithPaint(input).theme;
        },
        resolveWithPaint,
        clear: () => { current.clear(); },
    };
}

const effectiveThemeResolver = createThemeProfileResolver();
export const clearEffectiveThemeCache = effectiveThemeResolver.clear;
export const resolveThemeProfile = effectiveThemeResolver.resolve;
export const resolveThemeProfileWithPaint = effectiveThemeResolver.resolveWithPaint;
