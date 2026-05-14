import { t } from '@/text';
import { BUILT_IN_THEME_PROFILES } from '@/theme/profiles/builtInThemeProfiles';
import { resolveThemeProfileAssetAppearance } from '@/theme/profiles/themeProfileAssetAppearance';
import type { BuiltInThemeProfileDefinition, ThemeProfileMode, ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

export type ThemePresetSourceKind = 'base' | 'builtIn' | 'custom';

export type ThemePresetSourceOption = Readonly<{
    id: string;
    kind: ThemePresetSourceKind;
    title: string;
    subtitle: string;
    profile: ThemeProfileV1 | null;
    preferredMode: ThemeProfileMode;
    builtInDefinition?: BuiltInThemeProfileDefinition;
}>;

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
    themeProfiles: ThemeProfilesLocalStateV1,
): readonly ThemePresetSourceOption[] => [
    {
        id: 'light',
        kind: 'base',
        title: t('settingsAppearance.themeOptions.light'),
        subtitle: t('settingsAppearance.themeDescriptions.light'),
        profile: null,
        preferredMode: 'light',
    },
    {
        id: 'dark',
        kind: 'base',
        title: t('settingsAppearance.themeOptions.dark'),
        subtitle: t('settingsAppearance.themeDescriptions.dark'),
        profile: null,
        preferredMode: 'dark',
    },
    ...BUILT_IN_THEME_PROFILES.map((definition): ThemePresetSourceOption => ({
        id: definition.profile.id,
        kind: 'builtIn',
        title: t(definition.translationKey),
        subtitle: t('settingsAppearance.themeProfiles.readOnlyPreset'),
        profile: definition.profile,
        preferredMode: definition.preferredMode,
        builtInDefinition: definition,
    })),
    ...themeProfiles.profiles.map((profile): ThemePresetSourceOption => ({
        id: profile.id,
        kind: 'custom',
        title: profile.name,
        subtitle: t('settingsAppearance.themeProfiles.customProfileSubtitle'),
        profile,
        preferredMode: resolveThemePresetSourcePreferredMode(profile),
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
