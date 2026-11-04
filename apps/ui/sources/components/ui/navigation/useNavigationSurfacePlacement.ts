import * as React from 'react';

import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import {
    EMPTY_NAVIGATION_PLACEMENT_PREFERENCES,
    readNavigationSurfacePlacements,
    NavigationSurfacePlacementsV1Schema,
    type NavigationPlacementPreferences,
    type NavigationSurfaceId,
    type NavigationSurfacePlacementsV1,
} from '@/sync/domains/settings/mobileSurfacePinning';

/** Every surface subscribes to device preferences; mounting only reads historical seeds. */
export function useNavigationSurfacePlacement(surfaceId: NavigationSurfaceId): Readonly<{
    preferences: NavigationPlacementPreferences;
    placementsBySurface: NavigationSurfacePlacementsV1;
}> {
    const stored = useLocalSetting('navigationSurfacePlacementsV1');
    const legacyPhone = useLocalSetting('sessionCockpitBarSurfaceIds');
    const legacyApp = useLocalSetting('compactAppDestinationPreferencesV1');
    const placementsBySurface = React.useMemo(() => readNavigationSurfacePlacements({
        navigationSurfacePlacementsV1: stored,
        sessionCockpitBarSurfaceIds: legacyPhone,
        compactAppDestinationPreferencesV1: legacyApp,
    }), [legacyApp, legacyPhone, stored]);
    return { preferences: placementsBySurface[surfaceId] ?? EMPTY_NAVIGATION_PLACEMENT_PREFERENCES, placementsBySurface };
}

/** Only placement editors mount Action admission; read-only chrome retains its local subscription. */
export function useNavigationSurfacePlacementActionWriter(surfaceId: NavigationSurfaceId,
    placementsBySurface: NavigationSurfacePlacementsV1) {
    const writeSetting = useSettingActionWriter();
    return React.useCallback(async (preferences: NavigationPlacementPreferences): Promise<boolean> => {
        const value = NavigationSurfacePlacementsV1Schema.parse({ ...placementsBySurface, [surfaceId]: preferences });
        const outcome = await writeSetting({ anchor: 'appearance.navigationPlacements' }, value);
        return outcome.ok;
    }, [placementsBySurface, surfaceId, writeSetting]);
}
