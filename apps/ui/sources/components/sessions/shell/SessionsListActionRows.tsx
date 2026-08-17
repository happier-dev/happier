import * as React from 'react';
import { useGlobalSearchParams, usePathname, useRouter } from 'expo-router';
import { Platform } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Icon } from '@/components/ui/icons/Icon';
import {
    BROWSE_EXISTING_SESSIONS_DESTINATION_ID,
    isCompactAppDestinationCurrent,
    isCompactAppDestinationVisible,
    useCompactAppDestinations,
} from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { CompactAppDestinationBadge } from '@/components/appShell/destinations/CompactAppDestinationBadge';
import { usePluginAppPageCatalogActivationHandler } from '@/components/appShell/plugins/pluginAppPageNavigation';
import { ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX } from '@/components/ui/lists/itemGroupSpacing';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { useSetting } from '@/sync/domains/state/storage';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { useIsTablet } from '@/utils/platform/responsive';
import { resolveSessionListDensityViewState } from './resolveSessionListDensityViewState';

const stylesheet = StyleSheet.create(() => ({
    actionContainer: {
        // The group carries no title, so it draws a top spacer in its place; these rows sit flush
        // against the surface above, so cancel exactly that spacer — not an approximation of it.
        marginTop: -(Platform.select(ITEM_GROUP_HEADER_NO_TITLE_PADDING_TOP_PX) ?? 0),
    },
    actionGroupSurface: {
        backgroundColor: 'transparent',
        borderColor: 'transparent',
        borderWidth: 0,
        borderTopColor: 'transparent',
        borderTopWidth: 0,
        boxShadow: 'none',
        shadowOpacity: 0,
        shadowRadius: 0,
        elevation: 0,
    },
}));

export const SessionsListActionRows = React.memo(function SessionsListActionRows(props: Readonly<{
    externalSessionsEnabled: boolean;
}>) {
    const router = useRouter();
    const pathname = usePathname();
    const params = useGlobalSearchParams();
    const activatePluginAppPage = usePluginAppPageCatalogActivationHandler();
    const { theme } = useUnistyles();
    const styles = stylesheet;
    // These rows are the first entries of the session list, not a separate control strip, so they
    // take the session row's height from the same owner the list itself reads. Note this drops the
    // desktop-web row to the session grid's 34pt: that is deliberate. Desktop-web LIST rows follow
    // the session-list grid; desktop-web isolated icon controls follow the platform floor via
    // hitSlop.
    //
    // A native touch surface gets no such escape: the density row is 42pt on a phone and 34pt on a
    // tablet, both under the physical floor, and these rows carry no hitSlop of their own. So the
    // native height is raised to the platform minimum — from the same policy owner the rest of the
    // app reads, never a local 44/48 copy — while web keeps the density height untouched.
    const sessionListDensity = useSetting('sessionListDensity');
    const isTablet = useIsTablet();
    const densityRowHeight = resolveSessionListDensityViewState(sessionListDensity, {
        isTablet,
        platform: Platform.OS,
    }).rowHeight;
    const rowHeight = Platform.OS === 'ios' || Platform.OS === 'android'
        ? Math.max(densityRowHeight, resolveMinimumInteractiveTargetSize(Platform.OS))
        : densityRowHeight;
    const rowHeightStyle = React.useMemo(
        () => ({ height: rowHeight, minHeight: rowHeight }),
        [rowHeight],
    );
    const compactDestinations = useCompactAppDestinations({
        browseExistingSessionsEnabled: props.externalSessionsEnabled,
    });
    const destinations = React.useMemo(() => compactDestinations.filter((destination) => (
        isCompactAppDestinationVisible(destination)
        && (
            destination.kind === 'plugin'
            || destination.id === BROWSE_EXISTING_SESSIONS_DESTINATION_ID
        )
    )), [compactDestinations]);
    if (destinations.length === 0) return null;

    return (
        <ItemGroup
            style={styles.actionContainer}
            containerStyle={styles.actionGroupSurface}
            constrainToContentWidth={false}
        >
            {destinations.map((destination) => (
                <Item
                    key={destination.id}
                    testID={destination.kind === 'builtin'
                        ? 'external-sessions-browse-button'
                        : `compact-app-destination:${destination.id}`}
                    title={destination.title}
                    subtitle={destination.kind === 'plugin' && destination.availability === 'unavailable'
                        ? resolveReasonCopy({
                            reasonCode: destination.unavailableReason,
                            kind: 'pluginRuntime',
                        }).message
                        : undefined}
                    // `icon`, not `leftElement`: only `icon` is resized to the density's glyph
                    // scale, and only an unsized glyph lets that owner decide. The reserved box is
                    // then ITEM_ICON_BOX_SIZE.tight — the same 18pt box the session avatar sits in.
                    icon={<Icon name={destination.icon} color={theme.colors.text.secondary} />}
                    rightElement={destination.kind === 'plugin' && destination.badge ? (
                        <CompactAppDestinationBadge destination={destination} />
                    ) : undefined}
                    density="tight"
                    showChevron={false}
                    showDivider={false}
                    // `style` lands last on the row CONTAINER, so it beats the density minimum and
                    // the Pressable hugs it exactly; `pressableStyle` would leave dead space.
                    style={rowHeightStyle}
                    disabled={destination.availability !== 'available'}
                    selected={isCompactAppDestinationCurrent(destination, { pathname, params })}
                    onPress={destination.availability === 'available'
                        ? () => {
                            if (destination.kind === 'plugin' && destination.container === 'appPage') {
                                activatePluginAppPage(destination);
                                return;
                            }
                            router.push(destination.routePath as never);
                        }
                        : undefined}
                />
            ))}
        </ItemGroup>
    );
});
