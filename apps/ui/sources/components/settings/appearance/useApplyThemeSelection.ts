import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { ThemePreference } from '@/components/ui/layout/statusBarStyle';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { storage, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { DEFAULT_THEME_PROFILES_LOCAL_STATE } from '@/theme/profiles/themeProfilePersistence';
import { commitThemeSelection } from '@/theme/profiles/themeProfileRuntime';
import type { ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';

export { commitThemeSelection, previewThemeSelection } from '@/theme/profiles/themeProfileRuntime';

/** `commitThemeSelection` bound to this screen's local settings and reduced-motion preference. */
export function useApplyThemeSelection(beforeCommit?: () => void): (
    nextThemePreference: ThemePreference,
    nextThemeProfiles: ThemeProfilesLocalStateV1,
) => Promise<void> {
    const reduceMotion = useReducedMotionPreference();
    const [themePreference] = useLocalSettingMutable('themePreference');
    return React.useCallback((nextThemePreference, nextThemeProfiles) => {
        return commitThemeSelection({
            currentPreference: themePreference,
            nextPreference: nextThemePreference,
            nextThemeProfiles,
            reduceMotion,
            writeLocal: (delta) => {
                beforeCommit?.();
                storage.getState().applyLocalSettings(delta);
            },
        });
    }, [beforeCommit, reduceMotion, themePreference]);
}

/** The theme mode a stored preference means; anything unrecognised follows the system. */
export function resolveThemeMode(themePreference: unknown): ThemePreference {
    return themePreference === 'light' || themePreference === 'dark' ? themePreference : 'adaptive';
}

/**
 * Light ↔ dark in one press (the shell's title-strip toggle). The next mode is the opposite of the
 * theme on screen, stored as an explicit mode — so Adaptive becomes Light or Dark — through the same
 * writer as Settings → Appearance, keeping the theme each mode uses.
 */
export function useToggleThemeMode(): () => Promise<void> {
    const { theme } = useUnistyles();
    const [themeProfiles] = useLocalSettingMutable('themeProfiles');
    const applyThemeSelection = useApplyThemeSelection();
    const screenDark = theme.dark;
    return React.useCallback(() => {
        return applyThemeSelection(screenDark ? 'light' : 'dark', themeProfiles ?? DEFAULT_THEME_PROFILES_LOCAL_STATE);
    }, [applyThemeSelection, screenDark, themeProfiles]);
}
