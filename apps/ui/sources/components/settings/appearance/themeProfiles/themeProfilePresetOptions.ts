import { t } from '@/text';
import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { resolveThemeProfileAssetAppearance } from '@/theme/profiles/themeProfileAssetAppearance';
import { ThemeReferenceSchema, type ThemeLibraryEntry, type ThemeMiniatureData, type ThemeReference } from '@happier-dev/protocol/account/settings/themeProfiles';
import type { BuiltInThemeProfileDefinition, ThemeProfileMode, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

export type ThemePresetSourceKind = 'base' | 'builtIn' | 'custom';

export type ThemePresetSourceOption = Readonly<{
    id: string;
    kind: ThemePresetSourceKind;
    title: string;
    subtitle: string;
    profile: ThemeProfileV1 | null;
    preferredMode: ThemeProfileMode;
    builtInDefinition?: BuiltInThemeProfileDefinition;
    reference: ThemeReference | null;
    miniature?: ThemeMiniatureData;
    entry?: ThemeLibraryEntry;
}>;

/** Stable selection identity includes the reference namespace and contribution owner. */
export function getThemePresetSourceReferenceId(reference: ThemeReference): string {
    if (reference.kind === 'built-in') return reference.presetId;
    return JSON.stringify(reference.kind === 'artifact' ? ['artifact', reference.id]
        : ['plugin', reference.pluginId, reference.contributionId]);
}

/** Reads tagged routes and retained pre-reference Artifact links at this route boundary. */
export function readThemePresetSourceReferenceId(value: string | null): ThemeReference | null {
    if (!value || value === 'light' || value === 'dark') return null;
    const builtIn = BUILT_IN_THEME_PROFILES.find(definition => definition.presetId === value || definition.profile.id === value);
    if (builtIn) return { kind: 'built-in', presetId: builtIn.presetId };
    let candidate: unknown = { kind: 'artifact', id: value };
    if (value.startsWith('[')) {
        try {
            const tuple: unknown = JSON.parse(value);
            candidate = Array.isArray(tuple) && tuple[0] === 'artifact' && tuple.length === 2
                ? { kind: 'artifact', id: tuple[1] }
                : Array.isArray(tuple) && tuple[0] === 'plugin' && tuple.length === 3
                    ? { kind: 'plugin', pluginId: tuple[1], contributionId: tuple[2] } : null;
        } catch { return null; }
    }
    const parsed = ThemeReferenceSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

export const resolveThemePresetSourcePreferredMode = (profile: ThemeProfileV1): ThemeProfileMode => {
    return resolveThemeProfileAssetAppearance(profile);
};

const cloneOverrides = (overrides: ThemeProfileV1['overrides']): ThemeProfileV1['overrides'] => ({
    light: { ...overrides.light },
    dark: { ...overrides.dark },
});

const emptyOverrides = (): ThemeProfileV1['overrides'] => ({ light: {}, dark: {} });

const sortOverrides = (overrides: ThemeProfileV1['overrides']): ThemeProfileV1['overrides'] => ({
    light: Object.fromEntries(Object.entries(overrides.light).sort(([left], [right]) => left.localeCompare(right))),
    dark: Object.fromEntries(Object.entries(overrides.dark).sort(([left], [right]) => left.localeCompare(right))),
});

export const buildThemePresetSourceOptions = (
    entries: readonly ThemeLibraryEntry[],
): readonly ThemePresetSourceOption[] => [
    ...entries.filter(entry => entry.source.kind !== 'built-in').map((entry): ThemePresetSourceOption => ({
        id: getThemePresetSourceReferenceId(entry.reference),
        kind: 'custom',
        title: entry.name,
        subtitle: t('settingsAppearance.themeProfiles.customProfileSubtitle'),
        profile: null,
        preferredMode: entry.mode,
        reference: entry.reference,
        miniature: entry.miniature,
        entry,
    })),
    {
        id: 'light',
        kind: 'base',
        title: t('settingsAppearance.themeOptions.light'),
        subtitle: t('settingsAppearance.themeDescriptions.light'),
        profile: null,
        preferredMode: 'light',
        reference: null,
    },
    {
        id: 'dark',
        kind: 'base',
        title: t('settingsAppearance.themeOptions.dark'),
        subtitle: t('settingsAppearance.themeDescriptions.dark'),
        profile: null,
        preferredMode: 'dark',
        reference: null,
    },
    ...BUILT_IN_THEME_PROFILES.map((definition): ThemePresetSourceOption => ({
        id: definition.profile.id,
        kind: 'builtIn',
        title: t(definition.translationKey),
        subtitle: t('settingsAppearance.themeProfiles.readOnlyPreset'),
        profile: definition.profile,
        preferredMode: definition.preferredMode,
        builtInDefinition: definition,
        reference: { kind: 'built-in', presetId: definition.presetId },
    })),

];

const valuesSignature = (profile: Pick<ThemeProfileV1, 'base' | 'assetAppearance' | 'overrides'> | null): string => JSON.stringify({
    base: profile?.base ?? { light: 'light', dark: 'dark' },
    assetAppearance: profile ? resolveThemeProfileAssetAppearance(profile) : 'light',
    overrides: sortOverrides(profile ? profile.overrides : emptyOverrides()),
});

export const themeProfileDraftMatchesPresetSource = (
    draft: ThemeProfileV1,
    source: ThemePresetSourceOption,
): boolean => valuesSignature(draft) === valuesSignature(source.profile);

export const replaceThemeProfileDraftFromPresetSource = (
    draft: ThemeProfileV1,
    source: ThemePresetSourceOption,
    updatedAt: string,
): ThemeProfileV1 => ({
    ...draft,
    updatedAt,
    base: source.profile?.base ?? { light: 'light', dark: 'dark' },
    assetAppearance: source.profile ? resolveThemeProfileAssetAppearance(source.profile) : source.preferredMode,
    overrides: source.profile ? cloneOverrides(source.profile.overrides) : emptyOverrides(),
});
