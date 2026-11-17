import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import { getBaseTheme } from '@/theme/profiles/baseThemeCatalog';
import { compositeThemeColor, parseThemeColorValue, themeContrastRatio } from '@happier-dev/protocol/account/settings/themeColor';
import { readableThemeColorOnSurfaces } from '@/theme/themeContrast';
import { readThemeProfilePathValue } from '@/theme/profiles/themeProfilePathAccess';
import { getThemeProfileTokenDefinition, THEME_PROFILE_TOKEN_DEFINITIONS, type ThemeProfileTokenDefinition } from '@/theme/profiles/themeProfileTokenRegistry';
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

export type ThemeProfileContrastAnalysis = Readonly<{ warnings: readonly string[]; fix: string | null }>;

export type ThemeProfileEditorTokenValue = Readonly<{
    value: string;
    changed: boolean;
    contrast: ThemeProfileContrastAnalysis;
}>;

export type ResolvedThemeProfileEditorDraft = Readonly<{
    theme: Theme;
    tokens: Readonly<Record<string, ThemeProfileEditorTokenValue>>;
}>;

const emptyContrast: ThemeProfileContrastAnalysis = { warnings: [], fix: null };

const getResolvedContrastAnalysis = (
    values: Readonly<Record<string, string>>,
    canvas: ReturnType<typeof compositeThemeColor> | null,
    token: ThemeProfileTokenDefinition,
): ThemeProfileContrastAnalysis => {
    if (!token.contrastPairs?.length || !canvas) return emptyContrast;
    const value = parseThemeColorValue(values[token.id] ?? '');
    if (!value) return emptyContrast;

    const pairs = token.contrastPairs.flatMap((pair) => {
        const pairToken = getThemeProfileTokenDefinition(pair.tokenId);
        if (!pairToken) return [];
        const pairValue = parseThemeColorValue(values[pairToken.id] ?? '');
        if (!pairValue) return [];
        // Surfaces are painted over the canvas; the canvas itself is already composed once.
        const surface = pair.tokenId === 'background.canvas' ? canvas : compositeThemeColor(pairValue, canvas);
        return [{ ...pair, surface }];
    });
    const failing = pairs.filter(pair => themeContrastRatio(compositeThemeColor(value, pair.surface), pair.surface) < pair.minRatio);
    const fix = failing.length ? readableThemeColorOnSurfaces(values[token.id] ?? '', pairs.map(pair => ({
        surface: pair.surface, minContrast: pair.minRatio,
    }))) : null;
    return { warnings: failing.map(pair => pair.tokenId), fix };
};

/** One resolved palette supplies every editor row, contrast pair, seed and preview for this mode. */
export const resolveThemeProfileEditorDraft = (
    profile: ThemeProfileV1,
    mode: ThemeProfileMode,
): ResolvedThemeProfileEditorDraft => {
    const theme = resolveThemeProfile({ mode, profile });
    const overrides = profile.overrides[mode];
    const values = Object.fromEntries(THEME_PROFILE_TOKEN_DEFINITIONS.map(token => [
        token.id, readResolvedDraftTokenValue(theme, overrides, token),
    ]));
    const baseCanvas = parseThemeColorValue(getBaseTheme(mode).colors.background.canvas);
    const authoredCanvas = parseThemeColorValue(theme.colors.background.canvas);
    const canvas = baseCanvas && authoredCanvas ? compositeThemeColor(authoredCanvas, baseCanvas.rgb) : null;
    return { theme, tokens: Object.fromEntries(THEME_PROFILE_TOKEN_DEFINITIONS.map(token => [token.id, {
        value: values[token.id] ?? '',
        changed: Object.prototype.hasOwnProperty.call(overrides, token.id),
        contrast: getResolvedContrastAnalysis(values, canvas, token),
    }])) };
};

export const getThemeProfileContrastAnalysis = (
    profile: ThemeProfileV1,
    mode: ThemeProfileMode,
    token: ThemeProfileTokenDefinition,
): ThemeProfileContrastAnalysis => resolveThemeProfileEditorDraft(profile, mode).tokens[token.id]?.contrast ?? emptyContrast;

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
