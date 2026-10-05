import type { SettingStorageBinding } from '@/components/settings/catalog/settingDeclarations';
import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';

export const THEME_MODE_CHOICES = ['adaptive', 'light', 'dark'] as const;
type ThemeModeChoice = typeof THEME_MODE_CHOICES[number];

const isThemeMode = (value: unknown): value is ThemeModeChoice =>
    value === 'adaptive' || value === 'light' || value === 'dark';

/**
 * The theme mode as a declared device setting: Actions write it through the theme owner, which
 * also applies the running theme and status bar and keeps the theme each mode uses — a raw
 * `themePreference` write would store a choice the screen does not show.
 */
export const themeModeStorageBinding: SettingStorageBinding = {
    scope: 'local', kind: 'localOwner', access: 'read_write',
    allowedValues: THEME_MODE_CHOICES,
    read: local => isThemeMode(local.themePreference) ? local.themePreference : 'adaptive',
    parse: value => isThemeMode(value) ? { success: true, value } : { success: false },
    commit: async (local, value, writeLocal) => {
        if (!isThemeMode(value)) return;
        // The owner carries the runtime theme and status-bar modules; load them only when a write happens.
        const { commitThemeSelection } = await import('./useApplyThemeSelection');
        await commitThemeSelection({
            currentPreference: isThemeMode(local.themePreference) ? local.themePreference : 'adaptive',
            nextPreference: value,
            nextThemeProfiles: local.themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE,
            reduceMotion: readReducedMotionPreference(),
            writeLocal,
        });
    },
};
