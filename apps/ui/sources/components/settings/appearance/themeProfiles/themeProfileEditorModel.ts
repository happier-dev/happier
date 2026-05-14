import { resolveThemeProfile } from '@/theme/profiles/resolveThemeProfile';
import { readThemeProfilePathValue } from '@/theme/profiles/themeProfilePathAccess';
import { THEME_PROFILE_TOKEN_DEFINITIONS, type ThemeProfileTokenDefinition } from '@/theme/profiles/themeProfileTokenRegistry';
import type { ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

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

type ParsedColor = Readonly<{ r: number; g: number; b: number }>;

const parseColor = (value: string | undefined): ParsedColor | null => {
    if (!value) return null;
    const normalized = value.trim();
    const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(normalized);
    if (hex) {
        const raw = hex[1] ?? '';
        const expanded = raw.length === 3 || raw.length === 4
            ? raw.slice(0, 3).split('').map((part) => `${part}${part}`).join('')
            : raw.slice(0, 6);
        return {
            r: Number.parseInt(expanded.slice(0, 2), 16),
            g: Number.parseInt(expanded.slice(2, 4), 16),
            b: Number.parseInt(expanded.slice(4, 6), 16),
        };
    }
    const rgb = /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.exec(normalized);
    if (!rgb) return null;
    return {
        r: Number(rgb[1]),
        g: Number(rgb[2]),
        b: Number(rgb[3]),
    };
};

const channelToLinear = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
};

const luminance = (color: ParsedColor): number => (
    0.2126 * channelToLinear(color.r) + 0.7152 * channelToLinear(color.g) + 0.0722 * channelToLinear(color.b)
);

const contrastRatio = (left: ParsedColor, right: ParsedColor): number => {
    const leftLuminance = luminance(left);
    const rightLuminance = luminance(right);
    const lighter = Math.max(leftLuminance, rightLuminance);
    const darker = Math.min(leftLuminance, rightLuminance);
    return (lighter + 0.05) / (darker + 0.05);
};

export const readDraftTokenValue = (
    profile: ThemeProfileV1,
    mode: ThemeProfileMode,
    token: ThemeProfileTokenDefinition,
): string => {
    const theme = resolveThemeProfile({ mode, profile });
    return readThemeProfilePathValue(theme.colors, token.path) ?? profile.overrides[mode][token.id] ?? '';
};

export const getThemeProfileContrastWarnings = (
    profile: ThemeProfileV1,
    mode: ThemeProfileMode,
    token: ThemeProfileTokenDefinition,
): readonly string[] => {
    if (!token.contrastPairs?.length) return [];
    const value = parseColor(readDraftTokenValue(profile, mode, token));
    if (!value) return [];

    const warnings: string[] = [];
    for (const pair of token.contrastPairs) {
        const pairToken = THEME_PROFILE_TOKEN_DEFINITIONS.find((definition) => definition.id === pair.tokenId);
        if (!pairToken) continue;
        const pairValue = parseColor(readDraftTokenValue(profile, mode, pairToken));
        if (!pairValue) continue;
        if (contrastRatio(value, pairValue) < pair.minRatio) {
            warnings.push(pair.tokenId);
        }
    }
    return warnings;
};

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
