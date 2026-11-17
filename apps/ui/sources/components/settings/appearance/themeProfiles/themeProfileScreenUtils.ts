import type { ThemeProfilesLocalStateV1, ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';
import { parseThemeProfile } from '@/theme/profiles/themeProfilePersistence';

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

    return {
        ...state,
        profiles: [...state.profiles, sanitizedProfile],
    };
};
