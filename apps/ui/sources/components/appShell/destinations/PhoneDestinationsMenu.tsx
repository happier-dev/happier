import * as React from 'react';
import { View } from 'react-native';

import { BotsEntrySummary } from '@/components/sessions/bots/BotsEntrySummary';
import { useBotsSummary } from '@/components/sessions/bots/botsSummary';
import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { resolveTabBarMetrics, type TabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { CockpitTabBarActionView, type CockpitTabBarTabDefinition } from '@/components/navigation/mobile/chrome/bars/CockpitTabBar';
import { MainAppTabBar } from '@/components/navigation/mobile/chrome/bars/MainAppTabBar';
import { useSetting } from '@/sync/domains/state/storage';
import { resolveNavigationPlacements, type NavigationPlacement } from '@/sync/domains/settings/mobileSurfacePinning';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { Modal } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { destinationRowTestId, useColumnDestinations } from '@/components/appShell/destinations/ColumnDestinationRows';
import { CompactAppDestinationBadge } from '@/components/appShell/destinations/CompactAppDestinationBadge';
import { SEARCH_DESTINATION_ID, type CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { usePluginAppPagesMenu } from '@/components/appShell/destinations/PluginAppPagesMenu';
import { PHONE_HOME_ROUTE, useOpenPhoneHome } from '@/components/navigation/shell/PhoneHomeLogoButton';
import { useDestinationPathname } from '@/components/appShell/workspace/DestinationInstanceHost';

/**
 * What leads More before anyone customizes it: Search finds anything, Bots carries what needs you, Friends
 * are the people (no longer a tab, owner Q4) and Artifacts are what a phone is used to check. Nothing is on
 * the bar until the person puts it there (owner 11-06); Workflows is a tab.
 */
const PHONE_LAUNCHER_LEADING_IDS: readonly string[] = [SEARCH_DESTINATION_ID, 'bots', 'friends', 'artifacts'];
const CUSTOMIZE_ITEM_ID = 'phone-launcher:customize';
const NATIVE_ANCHOR_STYLE = { width: 0, height: 0 } as const;
/** Home leads the shortcuts (owner 2026-11-04): the page the desktop opens on, one tap away on a phone. */
const HOME_ITEM_ID = 'phone-launcher:home';

function phoneLauncherDefaultPlacement(destination: CompactAppDestination): NavigationPlacement {
    // A contextual plugin page (owner Q3) waits in Customize until the person places it.
    return destination.contextual ? 'hidden' : 'overflow';
}

function phoneLauncherOrder(destinations: readonly CompactAppDestination[]): readonly CompactAppDestination[] {
    const lead = (destination: CompactAppDestination) => {
        const index = PHONE_LAUNCHER_LEADING_IDS.indexOf(destination.id);
        return index < 0 ? PHONE_LAUNCHER_LEADING_IDS.length : index;
    };
    return [...destinations].sort((left, right) => lead(left) - lead(right));
}

/** A Bots slot on the bar says who wants the person without opening it (lab mnBots A). */
const BotsBarIcon = React.memo(function BotsBarIcon(props: Readonly<{ icon: IconName; size: number; tintColor: string }>) {
    const { needsYou } = useBotsSummary();
    return <>
        <Icon name={props.icon} size={props.size} color={props.tintColor} />
        {needsYou > 0 ? <TabBadge variant="dot" tone="attention" testID="tabbar-tab-bots-needs-you" /> : null}
    </>;
});

function phoneBarTab(destination: CompactAppDestination): CockpitTabBarTabDefinition<string> {
    return {
        id: destination.id, label: destination.title,
        icon: destination.activation === 'botsRoster'
            ? { render: ({ size, tintColor }) => <BotsBarIcon icon={destination.icon} size={size} tintColor={tintColor} /> }
            : destination.icon,
        disabled: destination.availability !== 'available',
        unavailableReason: destination.kind === 'plugin' && destination.availability === 'unavailable'
            ? resolveReasonCopy({ reasonCode: destination.unavailableReason, kind: 'pluginRuntime' }).message : undefined,
    };
}

/**
 * The phone's way to every destination its tabs do not show (owner 11-06). The person places each one on
 * the Bar, in More or Hidden (device-local): Bar items ride the floating main bar after its tabs, and More
 * lists Home, what was placed in More, then Customize. The native bar keeps UIKit's own tabs, so there its
 * Bar items lead More. Rows, availability and activation come from the one destination catalog.
 */
export function usePhoneDestinationsMore(input: Readonly<{ native: boolean }>) {
    const settingsMetrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    const { destinations, currentId, activate } = useColumnDestinations(undefined);
    const pluginPages = usePluginAppPagesMenu();
    const placement = useNavigationSurfacePlacement('phoneLauncher');
    const openHome = useOpenPhoneHome();
    const onHome = useDestinationPathname() === PHONE_HOME_ROUTE;
    const [open, setOpen] = React.useState(false);
    const placed = React.useMemo(() => resolveNavigationPlacements(phoneLauncherOrder(destinations).map((destination) => ({
        id: destination.id, destination, defaultPlacement: phoneLauncherDefaultPlacement(destination),
    })), placement.preferences), [destinations, placement.preferences]);
    const barTabs = React.useMemo(() => input.native ? [] : placed.pinned.map((entry) => phoneBarTab(entry.destination)),
        [input.native, placed]);

    const items = React.useMemo((): readonly DropdownMenuItem[] => {
        // A shortcut in More is dimmed when unavailable and does not repeat why; a pinned one the person
        // chose keeps its reason.
        const item = (destination: CompactAppDestination, category: string): DropdownMenuItem => ({
            id: destination.id,
            testID: destinationRowTestId(destination),
            title: destination.title,
            category,
            subtitle: category === 'pinned' && destination.kind === 'plugin' && destination.availability === 'unavailable'
                ? resolveReasonCopy({ reasonCode: destination.unavailableReason, kind: 'pluginRuntime' }).message
                : undefined,
            icon: <Icon name={destination.icon} />,
            rightElement: destination.kind === 'plugin' && destination.badge
                ? <CompactAppDestinationBadge destination={destination} />
                // The phone's one Bots entry carries the faces and what needs you (lab b-rail Ap).
                : destination.activation === 'botsRoster' ? <BotsEntrySummary /> : undefined,
            checked: destination.id === currentId,
            disabled: destination.availability !== 'available',
        });
        return [
            { id: HOME_ITEM_ID, testID: 'phone-launcher-home', title: t('common.home'), category: 'pinned',
                icon: <Icon name="house" />, checked: onHome },
            ...(input.native ? placed.pinned.map((entry) => item(entry.destination, 'pinned')) : []),
            ...placed.overflow.map((entry) => item(entry.destination, 'more')),
            { id: CUSTOMIZE_ITEM_ID, testID: 'phone-launcher-customize', title: t('navigationPlacement.customize'),
                category: 'customize', icon: <Icon name="sliders-horizontal" /> },
            ...(pluginPages.item ? [{ ...pluginPages.item, category: 'recovery' }] : []),
        ];
    }, [currentId, input.native, onHome, placed, pluginPages.item]);

    const select = React.useCallback((id: string) => {
        setOpen(false);
        if (pluginPages.select(id)) return;
        if (id === HOME_ITEM_ID) {
            openHome();
            return;
        }
        if (id === CUSTOMIZE_ITEM_ID) {
            const customizable = destinations.map((destination) => ({
                id: destination.id, title: destination.title, icon: destination.icon,
                defaultPlacement: phoneLauncherDefaultPlacement(destination),
            }));
            fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ NavigationPlacementCustomizer }) => {
                Modal.show({ component: NavigationPlacementCustomizer,
                    props: { surfaceId: 'phoneLauncher', items: customizable, testID: 'phone-launcher-customizer',
                        ...(input.native ? {} : { placementLabels: { pinned: t('navigationPlacement.bar') },
                            description: t('navigationPlacement.phoneBarDescription') }) } });
            }), { tag: 'PhoneDestinationsMenu.customize' });
            return;
        }
        const destination = destinations.find((candidate) => candidate.id === id);
        if (!destination || destination.availability !== 'available') return;
        const scope = captureActiveServerAccountScopeLifetime()?.scope ?? null;
        activate(destination, { searchScope: scope ? {
            accountId: scope.accountId, serverId: scope.serverId, sessionId: null, machineId: null, rootPath: null,
        } : undefined });
    }, [activate, destinations, input.native, openHome, pluginPages.select]);

    const openMenu = React.useCallback(() => setOpen(true), []);
    const available = destinations.length > 0;
    const renderMenu = (metrics: TabBarMetrics) => !available ? null : (
        <DropdownMenu
            testID="phone-launcher-menu"
            open={open}
            onOpenChange={setOpen}
            items={items}
            onSelect={select}
            separateCategories
            // A touch menu opens with nothing highlighted, so Search does not look chosen.
            allowEmptySelection
            placement="top"
            popoverAnchorAlign="end"
            matchTriggerWidth={false}
            maxWidthCap={280}
            popoverPortalWebTarget="body"
            popoverAccessibilityLabel={t('navigationPlacement.phoneLauncher')}
            trigger={({ open: expanded, toggle }) => input.native
                ? <View collapsable={false} testID="phone-launcher-native-anchor" style={NATIVE_ANCHOR_STYLE} />
                : <CockpitTabBarActionView testID="phone-launcher-button" label={t('common.more')} icon="dots-three"
                    metrics={metrics} expanded={expanded} onPress={toggle} />}
        />
    );
    return { available, menu: renderMenu(settingsMetrics), renderMenu, open: openMenu,
        bar: { tabs: barTabs, onPress: select } };
}

/** The floating main bar with the phone's destinations: the tabs, the Bar items, then More. */
export const PhoneMainAppTabBar = React.memo(function PhoneMainAppTabBar(
    props: Omit<React.ComponentProps<typeof MainAppTabBar>, 'destinations' | 'more'>,
) {
    const destinations = usePhoneDestinationsMore({ native: false });
    return <MainAppTabBar {...props} destinations={destinations.bar} more={destinations.available ? destinations.renderMenu : undefined} />;
});
