import type { EmbedStyleV1 } from '@happier-dev/protocol/embed';

import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { UI_FONT_SCALE_PRESETS } from '@/components/ui/text/uiFontScale';
import { installRuntimeWebFontFace, type RuntimeWebFontFaceResult } from '@/platform/installWebFontFaces';
import { getBuiltInThemeProfileDefinition, isBuiltInThemeProfilePresetId } from '@/theme/profiles/builtInThemeProfiles';
import { isValidThemeProfileColorValue } from '@/theme/profiles/themeProfileColorValidation';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';
import { isThemeProfilePublicTokenId } from '@/theme/profiles/themeProfileTokenRegistry';
import type { ThemeProfileColorOverrides, ThemeProfileMode, ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import type { ThemePartName, ThemeStyleSelection } from '@/theme/themeStyleScales';

const EMBED_PART_NAMES = ['userBubble', 'composer', 'toolCard', 'approvalCard', 'codeBlock', 'card', 'floating', 'primaryButton', 'secondaryButton'] as const satisfies readonly ThemePartName[];

/** The embed's in-memory theme profile. It is never saved; `updatedAt` is fixed and the resolver keys on its overrides. */
const EMBED_THEME_PROFILE_ID = 'embed';
const EMBED_PROFILE_TIMESTAMP = '1970-01-01T00:00:00.000Z';

/** A font file loaded without a family name still needs a name for the family variables to carry it. */
const EMBED_FONT_FILE_FAMILY = 'Embed font';

const TEXT_SIZE_SCALES = {
    compact: UI_FONT_SCALE_PRESETS.small,
    default: UI_FONT_SCALE_PRESETS.default,
    large: UI_FONT_SCALE_PRESETS.large,
} as const;

export type EmbedThemeApplication = Readonly<{
    themePreference: ThemePreference;
    themeProfiles: ThemeProfilesLocalStateV1;
    style: ThemeStyleSelection;
    fontUrl: string | null;
    uiFontScale: number;
}>;

function keepValidColors(colors: Readonly<Record<string, string>> | undefined): ThemeProfileColorOverrides {
    if (!colors) return {};
    return Object.fromEntries(Object.entries(colors).filter(([tokenId, value]) => (
        isThemeProfilePublicTokenId(tokenId) && isValidThemeProfileColorValue(value)
    )));
}

function presetOverrides(preset: string | undefined, mode: ThemeProfileMode): ThemeProfileColorOverrides {
    if (!preset || !isBuiltInThemeProfilePresetId(preset)) return {};
    return getBuiltInThemeProfileDefinition(preset)?.profile.overrides[mode] ?? {};
}

function resolveThemePreference(mode: EmbedStyleV1['mode']): ThemePreference {
    if (mode === 'light' || mode === 'dark') return mode;
    return 'adaptive';
}

function readPartSteps(parts: EmbedStyleV1['parts']): ThemeStyleSelection['parts'] {
    if (!parts) return undefined;
    const entries = EMBED_PART_NAMES.flatMap((part) => {
        const selection = parts[part];
        return selection ? [[part, selection] as const] : [];
    });
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The one mapping from `EmbedStyleV1` to the existing theme owners (plan 04 §4.7): colours become an
 * in-memory theme profile over an optional built-in preset (invalid or unknown tokens are dropped,
 * as the profile resolver does), mode becomes the theme preference, radius/density/parts/families
 * become the theme style selection, text size maps onto the app's text-scale presets.
 */
export function resolveEmbedThemeApplication(style: EmbedStyleV1 | null): EmbedThemeApplication {
    const overridesFor = (mode: ThemeProfileMode) => ({
        ...presetOverrides(style?.preset, mode),
        ...keepValidColors(style?.colors?.[mode]),
    });
    const profile: ThemeProfileV1 = {
        schemaVersion: 1,
        id: EMBED_THEME_PROFILE_ID,
        name: EMBED_THEME_PROFILE_ID,
        createdAt: EMBED_PROFILE_TIMESTAMP,
        updatedAt: EMBED_PROFILE_TIMESTAMP,
        base: { light: 'light', dark: 'dark' },
        overrides: { light: overridesFor('light'), dark: overridesFor('dark') },
    };
    const typography = style?.typography;
    const fontUrl = typography?.fontUrl?.trim() || null;
    const fontFamily = typography?.fontFamily?.trim() || (fontUrl ? EMBED_FONT_FILE_FAMILY : undefined);
    const selection: ThemeStyleSelection = {
        ...(style?.radius ? { radius: style.radius } : {}),
        ...(style?.density ? { density: style.density } : {}),
        ...(style?.finish ? { finish: style.finish } : {}),
        ...(readPartSteps(style?.parts) ? { parts: readPartSteps(style?.parts) } : {}),
        ...(fontFamily ? { fontFamily } : {}),
        ...(typography?.monoFontFamily?.trim() ? { monoFontFamily: typography.monoFontFamily.trim() } : {}),
    };
    return {
        themePreference: resolveThemePreference(style?.mode),
        themeProfiles: {
            activeProfileIds: { light: EMBED_THEME_PROFILE_ID, dark: EMBED_THEME_PROFILE_ID },
            profiles: [profile],
        },
        style: selection,
        fontUrl,
        uiFontScale: TEXT_SIZE_SCALES[typography?.scale ?? 'default'],
    };
}

type Colors = NonNullable<EmbedStyleV1['colors']>;

function mergeColors(base: Colors | undefined, override: Colors | undefined): Colors | undefined {
    if (!base) return override;
    if (!override) return base;
    return {
        ...(base.light || override.light ? { light: { ...base.light, ...override.light } } : {}),
        ...(base.dark || override.dark ? { dark: { ...base.dark, ...override.dark } } : {}),
    };
}

/**
 * Precedence (plan 04 §4.7): Happier default < the embed's saved style < the host's runtime style.
 * Later layers win field by field; colours and part radii merge token by token.
 */
export function mergeEmbedStyles(...layers: ReadonlyArray<EmbedStyleV1 | null | undefined>): EmbedStyleV1 | null {
    let merged: EmbedStyleV1 | null = null;
    for (const layer of layers) {
        if (!layer) continue;
        if (!merged) {
            merged = layer;
            continue;
        }
        const colors = mergeColors(merged.colors, layer.colors);
        const typography: EmbedStyleV1['typography'] = merged.typography || layer.typography ? { ...merged.typography, ...layer.typography } : undefined;
        const parts: EmbedStyleV1['parts'] = merged.parts || layer.parts ? Object.fromEntries(EMBED_PART_NAMES.flatMap(part => {
            const before = merged?.parts?.[part];
            const next = layer.parts?.[part];
            return before || next ? [[part, { ...before, ...next }]] : [];
        })) : undefined;
        merged = {
            ...merged,
            ...layer,
            ...(colors ? { colors } : {}),
            ...(typography ? { typography } : {}),
            ...(parts ? { parts } : {}),
        };
    }
    return merged;
}

export type ApplyEmbedStyleDependencies = Readonly<{
    applySelection: (input: Parameters<typeof applyThemeRuntimeSelection>[0]) => unknown;
    installFontFace: (input: Readonly<{ url: string | null }>) => Promise<RuntimeWebFontFaceResult>;
    applyLocalSettings: (delta: Readonly<{ uiFontScale: number }>, options: Readonly<{ persist: false }>) => void;
}>;

/**
 * Applies an embed style live: theme (colours, scales, families) through the theme runtime's
 * `updateTheme`, the text size as a runtime-only local setting, and the font file through the
 * runtime face. Open sessions restyle in place; nothing is persisted.
 */
export async function applyEmbedStyle(
    style: EmbedStyleV1 | null,
    dependencies: ApplyEmbedStyleDependencies,
): Promise<RuntimeWebFontFaceResult> {
    const application = resolveEmbedThemeApplication(style);
    dependencies.applySelection({
        themePreference: application.themePreference,
        themeProfiles: application.themeProfiles,
        style: application.style,
    });
    dependencies.applyLocalSettings({ uiFontScale: application.uiFontScale }, { persist: false });
    return await dependencies.installFontFace({ url: application.fontUrl });
}

export function createDefaultEmbedStyleDependencies(
    applyLocalSettings: ApplyEmbedStyleDependencies['applyLocalSettings'],
): ApplyEmbedStyleDependencies {
    return {
        applySelection: applyThemeRuntimeSelection,
        installFontFace: installRuntimeWebFontFace,
        applyLocalSettings,
    };
}
