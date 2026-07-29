import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { THEME_PROFILE_ID_PREFIX, THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';
import { isReservedThemeProfileId, isRouteSafeThemeProfileId, sanitizeThemeProfileName, sanitizeThemeProfileOverridesForV1TrustBoundary } from '@/theme/profiles/themeProfileImportExport';
import { inferThemeProfileAssetAppearance, isThemeProfileAssetAppearance } from '@/theme/profiles/themeProfileAssetAppearance';
import type { ThemeProfileMode, ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { activateThemeProfile } from '@/theme/profiles/themeProfileRuntime';
import { clearActiveThemeProfileReferences } from '@/theme/profiles/themeProfilePersistence';

export const createThemeProfileId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `${THEME_PROFILE_ID_PREFIX}${crypto.randomUUID()}`;
    }
    return `${THEME_PROFILE_ID_PREFIX}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
};

export const nowThemeProfileTimestamp = (): string => new Date().toISOString();

const sanitizeEditableThemeProfile = (profile: ThemeProfileV1): ThemeProfileV1 | null => {
    const id = profile.id.trim();
    const name = sanitizeThemeProfileName(profile.name);
    const overrides = sanitizeThemeProfileOverridesForV1TrustBoundary(profile.overrides);
    if (!id || !isRouteSafeThemeProfileId(id) || isReservedThemeProfileId(id) || !name || !overrides) return null;

    return {
        ...profile,
        id,
        name,
        base: { light: 'light', dark: 'dark' },
        assetAppearance: isThemeProfileAssetAppearance(profile.assetAppearance)
            ? profile.assetAppearance
            : inferThemeProfileAssetAppearance({ overrides }),
        overrides,
    };
};

export const upsertThemeProfile = (
    state: ThemeProfilesLocalStateV1,
    profile: ThemeProfileV1,
): ThemeProfilesLocalStateV1 => {
    const sanitizedProfile = sanitizeEditableThemeProfile(profile);
    if (!sanitizedProfile) return state;

    const existingProfile = state.profiles.some((entry) => entry.id === sanitizedProfile.id);
    if (existingProfile) {
        return {
            ...state,
            profiles: state.profiles.map((entry) => (entry.id === sanitizedProfile.id ? sanitizedProfile : entry)),
        };
    }

    if (state.profiles.length >= THEME_PROFILE_MAX_PROFILES) {
        return state;
    }

    return {
        ...state,
        profiles: [...state.profiles, sanitizedProfile],
    };
};

export const removeThemeProfile = (
    state: ThemeProfilesLocalStateV1,
    profileId: string,
): ThemeProfilesLocalStateV1 => ({
    ...clearActiveThemeProfileReferences(state, profileId),
    profiles: state.profiles.filter((entry) => entry.id !== profileId),
});

export const activateThemeProfileFromSettingsScreen = async (input: Readonly<{
    profileId: string | null;
    profileMode?: ThemeProfileMode | 'all';
    themePreference: ThemePreference;
    nextThemePreference?: ThemePreference;
    themeProfiles: ThemeProfilesLocalStateV1;
    setThemePreference?: (themePreference: ThemePreference) => void;
    setThemeProfiles: (state: ThemeProfilesLocalStateV1) => void;
    forceAnimate?: boolean;
    reduceMotion?: boolean;
}>): Promise<void> => {
    await activateThemeProfile({
        profileId: input.profileId,
        profileMode: input.profileMode,
        themePreference: input.nextThemePreference,
        forceAnimate: input.forceAnimate,
        reduceMotion: input.reduceMotion,
        loadLocalSettings: () => ({
            themePreference: input.themePreference,
            themeProfiles: input.themeProfiles,
        }),
        saveLocalSettings: (settings: LocalSettings) => {
            input.setThemePreference?.(settings.themePreference);
            input.setThemeProfiles(settings.themeProfiles);
        },
    });
};

export const buildLocalSettingsForThemeProfiles = (input: Readonly<{
    themePreference: ThemePreference;
    themeProfiles: ThemeProfilesLocalStateV1;
}>): LocalSettings => ({
    ...localSettingsDefaults,
    themePreference: input.themePreference,
    themeProfiles: input.themeProfiles,
});
