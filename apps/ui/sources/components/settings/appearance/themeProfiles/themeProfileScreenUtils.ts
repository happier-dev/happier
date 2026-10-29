import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';
import type { ThemeProfileMode, ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { activateThemeProfile } from '@/theme/profiles/themeProfileRuntime';
import { clearActiveThemeProfileReferences, parseThemeProfile } from '@/theme/profiles/themeProfilePersistence';
import type { ThemeProfileView } from '@/sync/domains/settings/themeProfiles';

export { createThemeProfileId } from '@/theme/profiles/themeProfileImportExport';

export const nowThemeProfileTimestamp = (): string => new Date().toISOString();

export const upsertThemeProfile = (
    state: ThemeProfilesLocalStateV1,
    profile: ThemeProfileV1,
): ThemeProfilesLocalStateV1 => {
    const sanitizedProfile = parseThemeProfile(profile)?.profile;
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
    setThemeProfiles: (state: ThemeProfilesLocalStateV1) => ThemeProfileView;
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
            const accepted = input.setThemeProfiles(settings.themeProfiles);
            input.setThemePreference?.(settings.themePreference);
            return { ...settings, themeProfiles: accepted.state };
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
