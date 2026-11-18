import * as React from 'react';
import { useSelectedThemeProfiles, useThemeProfileReferenceSelection } from '@/sync/store/useThemeProfiles';
import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';
import { THEME_PROJECTION_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { findActiveThemeProfileForMode } from './profiles/themeProfilePersistence';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { transitionThemeRuntimeSelection } from './profiles/themeProfileRuntime';
import { readReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { themeStyleSelectionFromSurfaceFinish } from './themeStyleScales';
import { getThemeTryOnOwner } from './profiles/themeTryOnRuntime';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

/** One narrow subscriber applies UI, Actions and Reset writes through the theme style owner. */
export function ThemeProfileRuntimeSync({ enabled = true }: Readonly<{ enabled?: boolean }>) {
    return enabled ? <ThemeProfileRuntimeObserver /> : null;
}

function ThemeProfileRuntimeObserver() {
    const scope = useAccountSettingsScope();
    const owner = getThemeTryOnOwner();
    const preview = React.useSyncExternalStore(owner.subscribe, owner.read, owner.read);
    const themePreference = useLocalSetting('themePreference');
    const references = useThemeProfileReferenceSelection();
    const themeProfiles = useSelectedThemeProfiles(references, scope);
    const lightPluginId = references.light?.kind === 'plugin' ? references.light.pluginId : null;
    const darkPluginId = references.dark?.kind === 'plugin' ? references.dark.pluginId : null;
    const light = findActiveThemeProfileForMode(themeProfiles, 'light');
    const dark = findActiveThemeProfileForMode(themeProfiles, 'dark');
    const finish = useLocalSetting('uiSurfaceFinish');
    const overrides = useLocalSetting('uiSurfaceFinishOverrides');
    React.useLayoutEffect(() => {
        fireAndForget(transitionThemeRuntimeSelection({
            themePreference,
            preview,
            themeProfiles: {
                activeProfileIds: { light: light?.id ?? null, dark: dark?.id ?? null },
                profiles: light ? (dark && dark !== light ? [light, dark] : [light]) : dark ? [dark] : [],
            },
            style: themeStyleSelectionFromSurfaceFinish({ uiSurfaceFinish: finish, uiSurfaceFinishOverrides: overrides }),
        }, readReducedMotionPreference()), { tag: 'theme.runtime.transition' });
    }, [themePreference, light, dark, finish, overrides, preview]);
    // A saved plugin theme is presented by the app itself, including before any catalog opens.
    if (!scope) return null;
    return <>
        {lightPluginId ? <PluginSurfaceProjectionDemand pluginId={lightPluginId} accountScope={scope}
            presents="allInstallations" sections={THEME_PROJECTION_SECTIONS} /> : null}
        {darkPluginId && darkPluginId !== lightPluginId ? <PluginSurfaceProjectionDemand pluginId={darkPluginId} accountScope={scope}
            presents="allInstallations" sections={THEME_PROJECTION_SECTIONS} /> : null}
    </>;
}
