import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { updateNavigationPlacement, type NavigationPlacementPreferences, type NavigationPlacementAddress } from '@/sync/domains/settings/mobileSurfacePinning';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useNavigationSurfacePlacementActionWriter } from './useNavigationSurfacePlacement';

/** More menus mount this editor only while open; both cockpit bars use the same Settings Action. */
export function NavigationPlacementPinButton(props: Readonly<{
    surfaceId: NavigationPlacementAddress;
    entryId: string;
    pinned: boolean;
    label: string;
    preferences: NavigationPlacementPreferences;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const setPreferences = useNavigationSurfacePlacementActionWriter(props.surfaceId);
    return <IconButton testID={props.testID} accessibilityLabel={props.label} tooltip={props.label}
        icon={<Icon name="push-pin" size={16} weight={props.pinned ? 'fill' : 'regular'}
            color={props.pinned ? theme.colors.text.primary : theme.colors.text.secondary} />}
        accessibilityRole="checkbox" checked={props.pinned}
        size={28} variant="plain" onPress={event => {
            event?.stopPropagation?.();
            fireAndForget(setPreferences(updateNavigationPlacement(props.preferences, props.entryId, props.pinned ? 'overflow' : 'pinned')),
                { tag: 'NavigationPlacementPinButton.pin' });
        }} />;
}
