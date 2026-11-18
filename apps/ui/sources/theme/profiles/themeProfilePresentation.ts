import { createPluginThemeProfileDocument, type ThemeLibraryEntry, type ThemeMiniatureData, type ThemeProfileDocument, type ThemeProfileMode, type ThemeProfileSource, type ThemeProfileV1 } from '@happier-dev/protocol/account/settings/themeProfiles';
import { THEME_MINIATURE_OVERRIDE_TOKENS, type ThemeProfileArtifactHeader } from '@happier-dev/protocol/account/settings/themeProfileArtifact';
import { resolveKnownFontFamily } from '@/constants/Typography';
import { DEFAULT_THEME_RADIUS_SCALE_NAME } from '@/theme/themeStyleScales';
import { resolveUncachedThemeProfile } from './resolveThemeProfile';
import { resolveThemeProfileAssetAppearance, resolveThemeProfileSupportedModes } from './themeProfileAssetAppearance';
import { getThemeProfileTokenDefinition } from './themeProfileTokenRegistry';
import { readThemeProfilePathValue } from './themeProfilePathAccess';

/** UI presentation support is platform-owned; the canonical raw document remains untouched. */
export function projectThemeProfileDocumentPresentation(document: ThemeProfileDocument): ThemeProfileDocument {
    const fontFamily = document.profile.style?.fontFamily;
    if (fontFamily === undefined) return document;
    const supported = resolveKnownFontFamily(fontFamily);
    if (supported === fontFamily) return document;
    const { fontFamily: _unsupported, ...style } = document.profile.style!;
    return { ...document, profile: { ...document.profile, style: { ...style, ...(supported ? { fontFamily: supported } : {}) } },
        compatibility: supported ? document.compatibility : { ...document.compatibility, status: 'partial',
            unsupportedPaths: [...new Set([...document.compatibility.unsupportedPaths, 'style.fontFamily'])] } };
}

export type ThemeMiniatureInput = Pick<ThemeProfileV1, 'overrides' | 'seeds' | 'assetAppearance' | 'style'>;

/** The admitted plugin declaration joins the library without an Artifact copy. */
export function projectPluginThemeProfileDocument(theme: ThemeProfileV1, source: Extract<ThemeProfileSource, { kind: 'plugin' }>): ThemeProfileDocument {
    return projectThemeProfileDocumentPresentation(createPluginThemeProfileDocument(theme, source));
}

/** Retain only authored inputs needed by the read-time miniature. */
export function projectThemeMiniaturePalette(profile: ThemeMiniatureInput, mode = resolveThemeProfileAssetAppearance(profile)): ThemeProfileArtifactHeader['palette'] {
    const authored = profile.overrides[mode];
    return { ...(profile.seeds ? { seeds: profile.seeds } : {}), radius: profile.style?.radius ?? DEFAULT_THEME_RADIUS_SCALE_NAME,
        overrides: Object.fromEntries(Object.values(THEME_MINIATURE_OVERRIDE_TOKENS).flatMap(token =>
            authored[token] === undefined ? [] : [[token, authored[token]]])) };
}

/** Resolve the same compact presentation for Artifact headers, built-ins and plugin declarations. */
export function projectThemeMiniature(
    profile: ThemeMiniatureInput,
    mode = resolveThemeProfileAssetAppearance(profile),
): ThemeMiniatureData {
    const { colors } = resolveUncachedThemeProfile({ mode, profile }).theme;
    const values = Object.fromEntries(Object.entries(THEME_MINIATURE_OVERRIDE_TOKENS).map(([role, token]) =>
        [role, readThemeProfilePathValue(colors, getThemeProfileTokenDefinition(token)!.path)!])) as Record<keyof typeof THEME_MINIATURE_OVERRIDE_TOKENS, string>;
    return { mode, ...values, radius: profile.style?.radius ?? DEFAULT_THEME_RADIUS_SCALE_NAME };
}

export function projectThemeLibraryEntry(document: ThemeProfileDocument, provenance?: ThemeProfileSource): ThemeLibraryEntry {
    const presented = projectThemeProfileDocumentPresentation(document);
    const source = provenance ?? presented.profile.source ?? { kind: 'yours' };
    const mode = resolveThemeProfileAssetAppearance(presented.profile);
    const modes = resolveThemeProfileSupportedModes(presented.profile);
    const miniatures: Partial<Record<ThemeProfileMode, ThemeMiniatureData>> = {};
    for (const supportedMode of modes) miniatures[supportedMode] = projectThemeMiniature(presented.profile, supportedMode);
    const miniature = miniatures[mode]!;
    const reference = source.kind === 'built-in' ? { kind: 'built-in' as const, presetId: source.presetId }
        : source.kind === 'plugin' ? { kind: 'plugin' as const, pluginId: source.pluginId, contributionId: source.contributionId }
            : { kind: 'artifact' as const, id: document.profile.id };
    return { id: document.profile.id, reference, name: document.profile.name, mode: miniature.mode, source,
        editable: source.kind === 'yours', deletable: source.kind === 'yours' || source.kind === 'store',
        compatibility: presented.compatibility, miniature, modes, miniatures };
}


/** Every library surface uses the same source join and stable source order. */
export function projectThemeLibraryEntries(saved: readonly ThemeLibraryEntry[], plugins: readonly ThemeLibraryEntry[], builtIns: readonly ThemeLibraryEntry[]): readonly ThemeLibraryEntry[] {
    return [...saved.filter(entry => entry.source.kind === 'yours'), ...saved.filter(entry => entry.source.kind !== 'yours'), ...plugins, ...builtIns];
}

type PluginLibraryInput = Pick<Extract<ThemeProfileSource, { kind: 'plugin' }>, 'pluginId' | 'contributionId'> & Readonly<{ theme: ThemeProfileV1 }>;
const pluginEntries = new WeakMap<PluginLibraryInput, ThemeLibraryEntry>();

/** Admitted plugin declarations join as references, never persisted Artifact copies. */
export function projectPluginThemeLibraryEntry(item: PluginLibraryInput): ThemeLibraryEntry {
    const previous = pluginEntries.get(item);
    if (previous) return previous;
    const entry = projectThemeLibraryEntry(projectPluginThemeProfileDocument(item.theme,
        { kind: 'plugin', pluginId: item.pluginId, contributionId: item.contributionId }));
    pluginEntries.set(item, entry);
    return entry;
}

export function projectPluginThemeLibraryEntries(items: readonly PluginLibraryInput[]): readonly ThemeLibraryEntry[] {
    return items.map(projectPluginThemeLibraryEntry);
}
