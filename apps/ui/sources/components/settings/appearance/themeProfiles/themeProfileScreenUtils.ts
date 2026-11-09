import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { THEME_PROFILE_MAX_PROFILES } from '@/theme/profiles/themeProfileConstants';
import type { ThemeProfileMode, ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { activateThemeProfile } from '@/theme/profiles/themeProfileRuntime';
import { clearActiveThemeProfileReferences, parseThemeProfile } from '@/theme/profiles/themeProfilePersistence';

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
    resolveProfileId?: () => string | null;
    profileMode?: ThemeProfileMode | 'all';
    nextThemePreference?: ThemePreference;
    readLocalSettings: () => Pick<LocalSettings, 'themePreference' | 'themeProfiles'>;
    /** An editor save merges only this draft into the current profile collection. */
    profile?: ThemeProfileV1;
    writeLocalSettings: (delta: Pick<LocalSettings, 'themePreference' | 'themeProfiles'>) => void;
    forceAnimate?: boolean;
    reduceMotion?: boolean;
}>): Promise<void> => {
    await activateThemeProfile({
        profileId: input.profileId,
        resolveProfileId: input.resolveProfileId,
        profileMode: input.profileMode,
        themePreference: input.nextThemePreference,
        forceAnimate: input.forceAnimate,
        reduceMotion: input.reduceMotion,
        loadLocalSettings: () => {
            const latest = input.readLocalSettings();
            return {
                ...latest,
                themeProfiles: input.profile ? upsertThemeProfile(latest.themeProfiles, input.profile) : latest.themeProfiles,
            };
        },
        saveLocalSettings: (settings: LocalSettings) => {
            input.writeLocalSettings({ themePreference: settings.themePreference, themeProfiles: settings.themeProfiles });
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
