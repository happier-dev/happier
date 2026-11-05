import * as React from 'react';

import { useSettingActionWriter } from '@/components/settings/catalog/useSettingActionWriter';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import {
    EMPTY_NAVIGATION_PLACEMENT_PREFERENCES,
    readNavigationPlacementPreferences,
    navigationPlacementsFromLegacyPins,
    navigationPreferencesFromLegacyAppDestinations,
    navigationPlacementPatch,
    resolveNavigationPlacementAddress,
    NavigationSurfacePlacementsV1Schema,
    type NavigationPlacementPreferences,
    type NavigationPlacementAddress,
    type NavigationSurfacePlacementsV1,
} from '@/sync/domains/settings/mobileSurfacePinning';

/** Every surface subscribes to device preferences; mounting only reads historical seeds. */
export function useNavigationSurfacePlacement(address: NavigationPlacementAddress, enabled = true): Readonly<{
    preferences: NavigationPlacementPreferences;
}> {
    const resolved = resolveNavigationPlacementAddress(address);
    const kind = typeof resolved === 'string' ? resolved : resolved.pageKind;
    const device = typeof resolved === 'string' ? null : resolved.device;
    const section = typeof resolved === 'string' ? null : resolved.section;
    const selector = React.useCallback((stored: NavigationSurfacePlacementsV1) => !enabled ? undefined : readNavigationPlacementPreferences(stored,
        device === 'phone' ? { pageKind: kind, device, section: 'items' }
            : device === 'desktop' ? { pageKind: kind, device, section: section === 'companions' ? section : 'pages' }
                : kind as Extract<NavigationPlacementAddress, string>), [kind, device, section, enabled]);
    const stored = useLocalSetting('navigationSurfacePlacementsV1', selector);
    const legacyPhone = useLocalSetting('sessionCockpitBarSurfaceIds', value => enabled && kind === 'sessionTabBar' && !stored ? value : undefined);
    const legacyApp = useLocalSetting('compactAppDestinationPreferencesV1', value => enabled && kind === 'appRail' && !stored ? value : undefined);
    const preferences = React.useMemo(() => stored ?? (legacyPhone !== undefined ? navigationPlacementsFromLegacyPins(legacyPhone)
        : legacyApp !== undefined ? navigationPreferencesFromLegacyAppDestinations(legacyApp) : EMPTY_NAVIGATION_PLACEMENT_PREFERENCES), [stored, legacyPhone, legacyApp]);
    return { preferences };
}

export function useDetailPageTabsPosition(pageKind: string, enabled = true): 'top' | 'bottom' {
    return useLocalSetting('navigationSurfacePlacementsV1', React.useCallback(value => enabled ? value.pageTabs?.[pageKind] ?? 'bottom' : 'bottom', [pageKind, enabled]));
}

export function useDetailPageTabsPositionActionWriter(pageKind: string) {
    const writeSetting = useSettingActionWriter();
    return React.useCallback(async (position: 'top' | 'bottom'): Promise<boolean> => {
        const outcome = await writeSetting({ anchor: 'appearance.navigationPlacements' }, { pageTabs: { [pageKind]: position } });
        return outcome.ok;
    }, [pageKind, writeSetting]);
}

/** Only placement editors mount Action admission; read-only chrome retains its local subscription. */
export function useNavigationSurfacePlacementActionWriter(surfaceId: NavigationPlacementAddress) {
    const writeSetting = useSettingActionWriter();
    return React.useCallback(async (preferences: NavigationPlacementPreferences): Promise<boolean> => {
        const value = NavigationSurfacePlacementsV1Schema.parse(navigationPlacementPatch(surfaceId, preferences));
        const outcome = await writeSetting({ anchor: 'appearance.navigationPlacements' }, value);
        return outcome.ok;
    }, [surfaceId, writeSetting]);
}
