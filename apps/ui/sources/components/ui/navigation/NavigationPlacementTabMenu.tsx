import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { ContextMenu } from '@/components/ui/forms/dropdown/ContextMenu';
import { Text } from '@/components/ui/text/Text';
import { buildNavigationPlacementMenu, type NavigationPlacementItem } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { useNavigationSurfacePlacementActionWriter } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import type { NavigationPlacementAddress, NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';

/**
 * A held phone tab's placement menu: the desktop tab menu's rows and writer, anchored to the tab. The bar mounts
 * it on the first hold, so always-mounted chrome holds no settings writer until someone asks for one.
 */
export function NavigationPlacementTabMenu(props: Readonly<{
    testID: string;
    address: NavigationPlacementAddress;
    item: NavigationPlacementItem;
    preferences: NavigationPlacementPreferences;
    open: boolean;
    anchorRef: React.RefObject<unknown>;
    onOpenChange: (open: boolean) => void;
    onCustomize: () => void;
}>) {
    const { theme } = useUnistyles();
    const onChange = useNavigationSurfacePlacementActionWriter(props.address);
    const menu = buildNavigationPlacementMenu({ item: props.item, preferences: props.preferences, onChange, onCustomize: props.onCustomize });
    const title = props.item.menuTitle ?? props.item.title;
    return <ContextMenu testID={props.testID} anchorRef={props.anchorRef} open={props.open} onOpenChange={props.onOpenChange}
        items={menu.items} separateCategories placement="top" popoverPortalWebTarget="body" popoverAccessibilityLabel={title}
        header={<Text style={{ padding: theme.space.s12, color: theme.colors.text.secondary }}>{title}</Text>}
        onSelect={id => { props.onOpenChange(false); return menu.onSelect(id); }} />;
}
