import * as React from 'react';
import { useThemeProfiles } from '@/sync/store/useThemeProfiles';
import { findActiveThemeProfileForMode } from './profiles/themeProfilePersistence';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { applyThemeRuntimeSelection } from './profiles/themeProfileRuntime';
import { themeStyleSelectionFromSurfaceFinish } from './themeStyleScales';
import { getThemeTryOnOwner } from './profiles/themeTryOnRuntime';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

/** One narrow subscriber applies UI, Actions and Reset writes through the theme style owner. */
export function ThemeProfileRuntimeSync({ enabled = true }: Readonly<{ enabled?: boolean }>) {
    return enabled ? <ThemeProfileRuntimeObserver /> : null;
}

function ThemeProfileRuntimeObserver() {
    useAccountSettingsScope();
    const owner = getThemeTryOnOwner();
    const preview = React.useSyncExternalStore(owner.subscribe, owner.read, owner.read);
    const themePreference = useLocalSetting('themePreference');
    const themeProfiles = useThemeProfiles();
    const light = findActiveThemeProfileForMode(themeProfiles, 'light');
    const dark = findActiveThemeProfileForMode(themeProfiles, 'dark');
    const finish = useLocalSetting('uiSurfaceFinish');
    const overrides = useLocalSetting('uiSurfaceFinishOverrides');
    React.useLayoutEffect(() => {
        applyThemeRuntimeSelection({
            themePreference,
            preview,
            themeProfiles: {
                activeProfileIds: { light: light?.id ?? null, dark: dark?.id ?? null },
                profiles: light ? (dark && dark !== light ? [light, dark] : [light]) : dark ? [dark] : [],
            },
            style: themeStyleSelectionFromSurfaceFinish({ uiSurfaceFinish: finish, uiSurfaceFinishOverrides: overrides }),
        });
    }, [themePreference, light, dark, finish, overrides, preview]);
    return null;
}
