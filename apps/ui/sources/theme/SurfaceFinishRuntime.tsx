import * as React from 'react';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import { applyThemeRuntimeSelection } from './profiles/themeProfileRuntime';
import { themeStyleSelectionFromSurfaceFinish } from './themeStyleScales';

/** One narrow subscriber applies UI, Actions and Reset writes through the theme style owner. */
export function SurfaceFinishRuntime() {
    const finish = useLocalSetting('uiSurfaceFinish');
    const overrides = useLocalSetting('uiSurfaceFinishOverrides');
    React.useLayoutEffect(() => {
        const local = storage.getState().localSettings;
        applyThemeRuntimeSelection({
            themePreference: local.themePreference,
            themeProfiles: local.themeProfiles,
            style: themeStyleSelectionFromSurfaceFinish({ uiSurfaceFinish: finish, uiSurfaceFinishOverrides: overrides }),
        });
    }, [finish, overrides]);
    return null;
}
