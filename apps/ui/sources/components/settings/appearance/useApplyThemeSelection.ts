import * as React from 'react';
import { Appearance, Platform } from 'react-native';
import { setStatusBarStyle } from 'expo-status-bar';
import { resolveStatusBarStyleForThemePreference, type ThemePreference } from '@/components/ui/layout/statusBarStyle';
import type { ThemeProfileView } from '@/sync/domains/settings/themeProfiles';
import type { ThemeProfilesLocalStateV1 } from '@/theme/profiles/themeProfileTypes';
import { applyThemeRuntimeSelection } from '@/theme/profiles/themeProfileRuntime';
import { runThemePreferenceChange } from './themePreferenceTransition';

export function useApplyThemeSelection(input: Readonly<{
    themePreference: ThemePreference;
    setThemePreference: (value: ThemePreference) => void;
    setThemeProfiles: (value: ThemeProfilesLocalStateV1) => ThemeProfileView;
    reduceMotion: boolean;
}>): (nextThemePreference: ThemePreference, nextThemeProfiles: ThemeProfilesLocalStateV1) => void {
    const { themePreference, setThemePreference, setThemeProfiles, reduceMotion } = input;
    return React.useCallback((nextThemePreference: ThemePreference, nextThemeProfiles: ThemeProfilesLocalStateV1) => {
        const systemTheme = Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
        void runThemePreferenceChange({
            currentPreference: themePreference,
            nextPreference: nextThemePreference,
            platform: Platform.OS,
            reduceMotion,
            forceAnimate: true,
            systemTheme,
            mutation: () => {
                const accepted = setThemeProfiles(nextThemeProfiles);
                setThemePreference(nextThemePreference);
                applyThemeRuntimeSelection({
                    themePreference: nextThemePreference,
                    themeProfiles: accepted.state,
                    systemTheme,
                });
                setStatusBarStyle(resolveStatusBarStyleForThemePreference(nextThemePreference, systemTheme), true);
            },
        });
    }, [reduceMotion, setThemePreference, setThemeProfiles, themePreference]);
}
