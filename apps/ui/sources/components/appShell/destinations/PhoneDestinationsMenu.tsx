import * as React from 'react';
import { View } from 'react-native';

import { BotsEntrySummary } from '@/components/sessions/bots/BotsEntrySummary';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { resolveTabBarMetrics, type TabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { CockpitTabBarActionView } from '@/components/navigation/mobile/chrome/bars/CockpitTabBar';
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
 * What the phone's shortcuts pin before anyone customizes them: Search finds anything, Bots carries what
 * needs you, Friends are the people (no longer a tab, owner Q4) and Artifacts are what a phone is used to
 * check. Workflows is a tab. Everything else follows under a hairline (More) until pinned.
 */
const PHONE_LAUNCHER_DEFAULT_PINNED_IDS: ReadonlySet<string> = new Set([SEARCH_DESTINATION_ID, 'friends', 'artifacts', 'bots']);
const CUSTOMIZE_ITEM_ID = 'phone-launcher:customize';
const NATIVE_ANCHOR_STYLE = { width: 0, height: 0 } as const;
/** Home leads the shortcuts (owner 2026-11-04): the page the desktop opens on, one tap away on a phone. */
const HOME_ITEM_ID = 'phone-launcher:home';

function phoneLauncherDefaultPlacement(destination: CompactAppDestination): NavigationPlacement {
    // A contextual plugin page (owner Q3) waits in Customize until the person pins it.
    if (destination.contextual) return 'hidden';
    return PHONE_LAUNCHER_DEFAULT_PINNED_IDS.has(destination.id) ? 'pinned' : 'overflow';
}

/**
 * The phone's way to every destination its tabs do not show: the tab bar's More, on every tab. Pinned
 * shortcuts lead, the rest follow under a hairline, then Customize — the same Pinned / More / Hidden placements
 * (device-local) the launcher always had. Rows, availability and activation come from the one destination
 * catalog. The floating bar draws the trigger in its last slot; the native bar owns its own item and opens this.
 */
export function usePhoneDestinationsMore(input: Readonly<{ native: boolean; metrics?: TabBarMetrics }>) {
    const settingsMetrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    const metrics = input.metrics ?? settingsMetrics;
    const { destinations, currentId, activate } = useColumnDestinations(undefined);
    const pluginPages = usePluginAppPagesMenu();
    const placement = useNavigationSurfacePlacement('phoneLauncher');
    const openHome = useOpenPhoneHome();
    const onHome = useDestinationPathname() === PHONE_HOME_ROUTE;
    const [open, setOpen] = React.useState(false);
    const placed = React.useMemo(() => resolveNavigationPlacements(destinations.map((destination) => ({
        id: destination.id, destination, defaultPlacement: phoneLauncherDefaultPlacement(destination),
    })), placement.preferences), [destinations, placement.preferences]);

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
            ...placed.pinned.map((entry) => item(entry.destination, 'pinned')),
            ...placed.overflow.map((entry) => item(entry.destination, 'more')),
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
                    props: { surfaceId: 'phoneLauncher', items: customizable, testID: 'phone-launcher-customizer' } });
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
    const menu = !available ? null : (
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
    return { available, menu, open: openMenu };
}

export const PhoneDestinationsMenu = React.memo(function PhoneDestinationsMenu(props: Readonly<{ metrics?: TabBarMetrics }>) {
    return usePhoneDestinationsMore({ native: false, metrics: props.metrics }).menu;
});
