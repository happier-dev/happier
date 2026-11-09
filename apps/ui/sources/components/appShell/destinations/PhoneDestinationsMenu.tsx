import * as React from 'react';
import { View } from 'react-native';

import { BotsEntrySummary } from '@/components/sessions/bots/BotsEntrySummary';
import { useBotsSummary } from '@/components/sessions/bots/botsSummary';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { NavigationPlacementTabMenu } from '@/components/ui/navigation/NavigationPlacementTabMenu';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { resolveTabBarMetrics, type TabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { CockpitTabBarActionView, type CockpitTabBarTabDefinition } from '@/components/navigation/mobile/chrome/bars/CockpitTabBar';
import { MainAppTabBar } from '@/components/navigation/mobile/chrome/bars/MainAppTabBar';
import { sfSymbolForCockpitTabIcon } from '@/components/navigation/mobile/chrome/bars/cockpitTabSymbols';
import { useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { readNavigationPlacementPreferences, resolveNavigationPlacements, type NavigationPlacement, type NavigationSurfacePlacementsV1 } from '@/sync/domains/settings/mobileSurfacePinning';
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
    // Contextual pages and Settings wait in Customize; Settings already has its avatar door.
    return destination.contextual || destination.id === 'settings' ? 'hidden' : 'overflow';
}

/** The chrome consumes the same placement decision as its launcher, without subscribing to other choices. */
export function usePhoneLauncherDestinationPinned(destination: CompactAppDestination | null): boolean {
    return useLocalSetting('navigationSurfacePlacementsV1', React.useCallback((stored: NavigationSurfacePlacementsV1) => destination !== null
        && resolveNavigationPlacements([{ id: destination.id, defaultPlacement: phoneLauncherDefaultPlacement(destination) }],
            readNavigationPlacementPreferences(stored, 'phoneLauncher')).effectivePlacements[destination.id] === 'pinned', [destination]));
}

function phoneLauncherOrder(destinations: readonly CompactAppDestination[]): readonly CompactAppDestination[] {
    const lead = (destination: CompactAppDestination) => {
        const index = PHONE_LAUNCHER_LEADING_IDS.indexOf(destination.id);
        return index < 0 ? PHONE_LAUNCHER_LEADING_IDS.length : index;
    };
    return [...destinations].sort((left, right) => lead(left) - lead(right));
}

function phoneBarTab(destination: CompactAppDestination, botsNeedsYou: number): CockpitTabBarTabDefinition<string> & Readonly<{ sfSymbol: string }> {
    return {
        id: destination.id, label: destination.title,
        sfSymbol: sfSymbolForCockpitTabIcon(destination.icon),
        icon: destination.icon,
        badge: destination.activation === 'botsRoster'
            ? botsNeedsYou > 0 ? { kind: 'attention' } : undefined
            : destination.kind === 'plugin' && destination.badge ? { kind: 'text', value: destination.badge.label } : undefined,
        disabled: destination.availability !== 'available',
        unavailableReason: destination.kind === 'plugin' && destination.availability === 'unavailable'
            ? resolveReasonCopy({ reasonCode: destination.unavailableReason, kind: 'pluginRuntime' }).message : undefined,
    };
}

/**
 * The phone's way to every destination its tabs do not show (owner 11-06). The person places each one on
 * the Bar, in More or Hidden (device-local): Bar items ride the floating main bar after its tabs, and More
 * lists Home, what was placed in More, then Customize. UIKit and the custom bar consume the same Bar
 * items. Rows, availability and activation come from the one destination catalog.
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
    const { needsYou } = useBotsSummary(placed.pinned.some(entry => entry.destination.activation === 'botsRoster'));
    const barTabs = React.useMemo(() => placed.pinned.map((entry) => phoneBarTab(entry.destination, needsYou)), [placed, needsYou]);

    const items = React.useMemo((): readonly DropdownMenuItem[] => {
        // More dims unavailable shortcuts; the bar keeps the reason for an explicitly pinned one.
        const item = (destination: CompactAppDestination): DropdownMenuItem => ({
            id: destination.id,
            testID: destinationRowTestId(destination),
            title: destination.title,
            category: 'more',
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
            ...placed.overflow.map((entry) => item(entry.destination)),
            { id: CUSTOMIZE_ITEM_ID, testID: 'phone-launcher-customize', title: t('navigationPlacement.customize'),
                category: 'customize', icon: <Icon name="sliders-horizontal" /> },
            ...(pluginPages.item ? [{ ...pluginPages.item, category: 'recovery' }] : []),
        ];
    }, [currentId, onHome, placed, pluginPages.item]);

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
                        placementLabels: { pinned: t('navigationPlacement.bar') },
                        description: t('navigationPlacement.phoneBarDescription') } });
            }), { tag: 'PhoneDestinationsMenu.customize' });
            return;
        }
        const destination = destinations.find((candidate) => candidate.id === id);
        if (!destination || destination.availability !== 'available') return;
        const scope = captureActiveServerAccountScopeLifetime()?.scope ?? null;
        activate(destination, { searchScope: scope ? {
            accountId: scope.accountId, serverId: scope.serverId, sessionId: null, machineId: null, rootPath: null,
        } : undefined });
    }, [activate, destinations, openHome, pluginPages.select]);

    const openMenu = React.useCallback(() => setOpen(true), []);
    const available = destinations.length > 0;
    // A held tab's menu: a kept destination moves or hides; a main tab is fixed, so it only offers Customize.
    const [tabMenu, setTabMenu] = React.useState<Readonly<{ id: string; label: string; open: boolean }> | null>(null);
    const tabAnchor = React.useRef<unknown>(null);
    const holdTab = React.useCallback((id: string, anchor: unknown, label: string) => {
        tabAnchor.current = anchor;
        setTabMenu({ id, label, open: true });
    }, []);
    const closeTabMenu = React.useCallback((next: boolean) => {
        if (!next) setTabMenu(current => current && { ...current, open: false });
    }, []);
    const heldDestination = tabMenu ? destinations.find((destination) => destination.id === tabMenu.id) : undefined;
    const renderMenu = (metrics: TabBarMetrics) => !available ? null : <>
        {tabMenu ? <NavigationPlacementTabMenu testID="phone-launcher-tab-menu" address="phoneLauncher" preferences={placement.preferences}
            item={heldDestination
                ? { id: heldDestination.id, title: heldDestination.title, defaultPlacement: phoneLauncherDefaultPlacement(heldDestination) }
                : { id: tabMenu.id, title: tabMenu.label, defaultPlacement: 'pinned', allowedPlacements: ['pinned'] }}
            open={tabMenu.open} anchorRef={tabAnchor} onOpenChange={closeTabMenu} onCustomize={() => select(CUSTOMIZE_ITEM_ID)} /> : null}
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
    </>;
    return { available, menu: renderMenu(settingsMetrics), renderMenu, open: openMenu,
        bar: { tabs: barTabs, onPress: select, ...(input.native || !available ? {} : { onTabLongPress: holdTab }) } };
}

/** The floating main bar with the phone's destinations: the tabs, the Bar items, then More. */
export const PhoneMainAppTabBar = React.memo(function PhoneMainAppTabBar(
    props: Omit<React.ComponentProps<typeof MainAppTabBar>, 'destinations' | 'more'>,
) {
    const destinations = usePhoneDestinationsMore({ native: false });
    return <MainAppTabBar {...props} destinations={destinations.bar} more={destinations.available ? destinations.renderMenu : undefined} />;
});
