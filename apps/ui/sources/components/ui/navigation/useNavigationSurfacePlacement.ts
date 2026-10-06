import * as React from 'react';

import { storage, useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import {
    EMPTY_NAVIGATION_PLACEMENT_PREFERENCES,
    NavigationSurfacePlacementsV1Schema,
    readNavigationSurfacePlacements,
    type NavigationPlacementPreferences,
    type NavigationSurfaceId,
    type NavigationSurfacePlacementsV1,
} from '@/sync/domains/settings/mobileSurfacePinning';

/** Every surface subscribes to device preferences; mounting only reads historical seeds. */
export function useNavigationSurfacePlacement(surfaceId: NavigationSurfaceId): Readonly<{
    preferences: NavigationPlacementPreferences;
    placementsBySurface: NavigationSurfacePlacementsV1;
    setPreferences(preferences: NavigationPlacementPreferences): void;
}> {
    const [stored, setStored] = useLocalSettingMutable('navigationSurfacePlacementsV1');
    const legacyPhone = useLocalSetting('sessionCockpitBarSurfaceIds');
    const legacyApp = useLocalSetting('compactAppDestinationPreferencesV1');
    const placementsBySurface = React.useMemo(() => readNavigationSurfacePlacements({
        navigationSurfacePlacementsV1: stored,
        sessionCockpitBarSurfaceIds: legacyPhone,
        compactAppDestinationPreferencesV1: legacyApp,
    }), [legacyApp, legacyPhone, stored]);
    const setPreferences = React.useCallback((preferences: NavigationPlacementPreferences) => {
        const current = readNavigationSurfacePlacements(storage.getState().localSettings);
        setStored(NavigationSurfacePlacementsV1Schema.parse({ ...current, [surfaceId]: preferences }));
    }, [setStored, surfaceId]);
    return { preferences: placementsBySurface[surfaceId] ?? EMPTY_NAVIGATION_PLACEMENT_PREFERENCES, placementsBySurface, setPreferences };
}
