import { THEME_PROFILE_MAX_OVERRIDES_PER_MODE, THEME_PROFILE_SCHEMA_VERSION } from './themeProfileConstants';
import { resolveThemeProfileAssetAppearance } from './themeProfileAssetAppearance';
import type { ThemeProfileColorOverrides, ThemeProfileMode, ThemeProfileV1 } from './themeProfileTypes';

type CreateThemeProfileDraftInput = Readonly<{
    id: string;
    name: string;
    now: string;
    sourceProfile?: ThemeProfileV1;
}>;

const cloneOverrides = (overrides: ThemeProfileV1['overrides']): ThemeProfileV1['overrides'] => ({
    light: { ...overrides.light },
    dark: { ...overrides.dark },
});

const emptyOverrides = (): ThemeProfileV1['overrides'] => ({ light: {}, dark: {} });

const updateModeOverrides = (
    profile: ThemeProfileV1,
    mode: ThemeProfileMode,
    nextModeOverrides: ThemeProfileColorOverrides,
    updatedAt: string,
): ThemeProfileV1 => ({
    ...profile,
    updatedAt,
    overrides: {
        ...profile.overrides,
        [mode]: nextModeOverrides,
    },
});

export const createThemeProfileDraft = ({ id, name, now, sourceProfile }: CreateThemeProfileDraftInput): ThemeProfileV1 => ({
    schemaVersion: THEME_PROFILE_SCHEMA_VERSION,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    base: { light: 'light', dark: 'dark' },
    ...(sourceProfile ? { assetAppearance: resolveThemeProfileAssetAppearance(sourceProfile) } : {}),
    overrides: sourceProfile ? cloneOverrides(sourceProfile.overrides) : emptyOverrides(),
});

export const updateThemeProfileDraftColor = (
    profile: ThemeProfileV1,
    mode: ThemeProfileMode,
    tokenId: string,
    value: string,
    updatedAt: string,
): ThemeProfileV1 => {
    const modeOverrides = profile.overrides[mode];
    if (!(tokenId in modeOverrides) && Object.keys(modeOverrides).length >= THEME_PROFILE_MAX_OVERRIDES_PER_MODE) {
        return profile;
    }

    return updateModeOverrides(profile, mode, { ...modeOverrides, [tokenId]: value }, updatedAt);
};

export const resetThemeProfileDraftToken = (
    profile: ThemeProfileV1,
    mode: ThemeProfileMode,
    tokenId: string,
    updatedAt: string,
): ThemeProfileV1 => {
    const { [tokenId]: _removed, ...remainingOverrides } = profile.overrides[mode];
    void _removed;
    return updateModeOverrides(profile, mode, remainingOverrides, updatedAt);
};

export const resetThemeProfileDraftMode = (
    profile: ThemeProfileV1,
    mode: ThemeProfileMode,
    updatedAt: string,
): ThemeProfileV1 => updateModeOverrides(profile, mode, {}, updatedAt);
