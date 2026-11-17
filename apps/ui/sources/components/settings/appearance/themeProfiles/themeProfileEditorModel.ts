import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import { getBaseTheme } from '@/theme/profiles/baseThemeCatalog';
import { compositeThemeColor, parseThemeColorValue, themeContrastRatio } from '@happier-dev/protocol/account/settings/themeColor';
import { readableThemeColorOnSurfaces } from '@/theme/themeContrast';
import { readThemeProfilePathValue } from '@/theme/profiles/themeProfilePathAccess';
import { THEME_PROFILE_TOKEN_DEFINITIONS, type ThemeProfileTokenDefinition } from '@/theme/profiles/themeProfileTokenRegistry';
import type { ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import type { Theme } from '@/theme';

export type ThemeProfileTokenGroupModel = Readonly<{
    group: string;
    tokens: readonly ThemeProfileTokenDefinition[];
}>;

export const buildThemeProfileTokenGroups = (): readonly ThemeProfileTokenGroupModel[] => {
    const groups = new Map<string, ThemeProfileTokenDefinition[]>();
    for (const token of THEME_PROFILE_TOKEN_DEFINITIONS) {
        const existing = groups.get(token.group) ?? [];
        existing.push(token);
        groups.set(token.group, existing);
    }
    return Array.from(groups.entries()).map(([group, tokens]) => ({ group, tokens }));
};

const readResolvedDraftTokenValue = (
    theme: Theme,
    overrides: ThemeProfileV1['overrides'][ThemeProfileMode],
    token: ThemeProfileTokenDefinition,
): string => readThemeProfilePathValue(theme.colors, token.path) ?? overrides[token.id] ?? '';

export const readDraftTokenValue = (
    profile: ThemeProfileV1,
    mode: ThemeProfileMode,
    token: ThemeProfileTokenDefinition,
): string => {
    const theme = resolveThemeProfile({ mode, profile });
    return readResolvedDraftTokenValue(theme, profile.overrides[mode], token);
};

export type ThemeProfileContrastAnalysis = Readonly<{ warnings: readonly string[]; fix: string | null }>;

export const getThemeProfileContrastAnalysis = (
    profile: ThemeProfileV1,
    mode: ThemeProfileMode,
    token: ThemeProfileTokenDefinition,
): ThemeProfileContrastAnalysis => {
    const empty: ThemeProfileContrastAnalysis = { warnings: [], fix: null };
    if (!token.contrastPairs?.length) return empty;
    const theme = resolveThemeProfile({ mode, profile });
    const readValue = (definition: ThemeProfileTokenDefinition) => readResolvedDraftTokenValue(theme, profile.overrides[mode], definition);
    const value = parseThemeColorValue(readValue(token));
    if (!value) return empty;
    const baseCanvas = parseThemeColorValue(getBaseTheme(mode).colors.background.canvas);
    const authoredCanvas = parseThemeColorValue(theme.colors.background.canvas);
    if (!baseCanvas || !authoredCanvas) return empty;
    const canvas = compositeThemeColor(authoredCanvas, baseCanvas.rgb);

    const pairs = token.contrastPairs.flatMap((pair) => {
        const pairToken = THEME_PROFILE_TOKEN_DEFINITIONS.find((definition) => definition.id === pair.tokenId);
        if (!pairToken) return [];
        const pairValue = parseThemeColorValue(readValue(pairToken));
        if (!pairValue) return [];
        // Surfaces are painted over the canvas; the canvas itself is already composed once.
        const surface = pair.tokenId === 'background.canvas' ? canvas : compositeThemeColor(pairValue, canvas);
        return [{ ...pair, surface }];
    });
    const failing = pairs.filter(pair => themeContrastRatio(compositeThemeColor(value, pair.surface), pair.surface) < pair.minRatio);
    const fix = failing.length ? readableThemeColorOnSurfaces(readValue(token), pairs.map(pair => ({
        surface: pair.surface, minContrast: pair.minRatio,
    }))) : null;
    return { warnings: failing.map(pair => pair.tokenId), fix };
};

export const getThemeProfileContrastWarnings = (
    profile: ThemeProfileV1,
    mode: ThemeProfileMode,
    token: ThemeProfileTokenDefinition,
): readonly string[] => getThemeProfileContrastAnalysis(profile, mode, token).warnings;

export const getThemeProfileRecentColors = (profile: ThemeProfileV1): readonly string[] => {
    const colors: string[] = [];
    for (const mode of ['light', 'dark'] as const) {
        for (const value of Object.values(profile.overrides[mode])) {
            if (!colors.includes(value)) {
                colors.unshift(value);
            }
        }
    }
    return colors.slice(0, 8);
};
