import * as React from 'react';

import { useLocalSetting, useThemeProfiles } from '@/sync/domains/state/storage';
import { findActiveThemeProfileForMode } from './themeProfilePersistence';
import { applyThemeRuntimeSelection } from './themeProfileRuntime';

/** Refresh active colors when account sync updates the selected profile on another device. */
export function ThemeProfileRuntimeSync() {
    const themePreference = useLocalSetting('themePreference');
    const themeProfiles = useThemeProfiles();
    const light = findActiveThemeProfileForMode(themeProfiles, 'light');
    const dark = findActiveThemeProfileForMode(themeProfiles, 'dark');
    React.useEffect(() => {
        applyThemeRuntimeSelection({
            themePreference,
            themeProfiles: {
                activeProfileIds: { light: light?.id ?? null, dark: dark?.id ?? null },
                profiles: light ? (dark && dark !== light ? [light, dark] : [light]) : dark ? [dark] : [],
            },
        });
    }, [themePreference, light, dark]);
    return null;
}
