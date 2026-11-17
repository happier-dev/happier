import * as React from 'react';
import { View } from 'react-native';

import { BotsEntrySummary } from '@/components/sessions/bots/BotsEntrySummary';
import { orderedBotAccessibilityLabel, useBotsSummary, useOrderedBotNames, useOrderedBots } from '@/components/sessions/bots/botsSummary';
import type { OrderedBot } from '@/components/sessions/bots/botActivity';
import { BOTS_GLYPH } from '@/components/sessions/bots/botsGlyph';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { NavigationPlacementTabMenu } from '@/components/ui/navigation/NavigationPlacementTabMenu';
import { NavigationPlacementPinButton } from '@/components/ui/navigation/NavigationPlacementPinButton';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { resolveTabBarMetrics, type TabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { CockpitTabBarActionView, type CockpitTabBarTabDefinition } from '@/components/navigation/mobile/chrome/bars/CockpitTabBar';
import { MainAppTabBar } from '@/components/navigation/mobile/chrome/bars/MainAppTabBar';
import { resolveMainAppTabFacts, useMainAppTabKeys } from '@/components/navigation/mobile/chrome/bars/useMainAppTabDefinitions';
import type { TabType } from '@/components/ui/navigation/tabTypes';
import { StyleSheet } from 'react-native-unistyles';
import { sfSymbolForCockpitTabIcon } from '@/components/navigation/mobile/chrome/bars/cockpitTabSymbols';
import { useLocalSetting, useSetting } from '@/sync/domains/state/storage';
import { isPhoneBotPlacementId, phoneBotPlacementId, readNavigationPlacementPreferences, resolveNavigationPlacements, resolveNavigationVisitor, type NavigationPlacement, type NavigationSurfacePlacementsV1 } from '@/sync/domains/settings/navigationPlacement';
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
/** A main tab's row in More; the tab itself stays the navigation authority. */
const MAIN_TAB_ITEM_PREFIX = 'phone-launcher-main:';
/** A main tab's placement id: the bar's own tabs are phoneLauncher placements like every Bar item (owner 11-10). */
const MAIN_TAB_PLACEMENT_PREFIX = 'tab:';
/** A main tab rides the bar or waits in More; it is never hidden, so it always has a way back. */
const MAIN_TAB_PLACEMENTS: readonly NavigationPlacement[] = ['pinned', 'overflow'];

/** What the bar's own tabs need from their owner here: which one is open, and how to open one. */
export type PhoneMainTabs = Readonly<{ activeId: string | null; onTabPress: (tab: TabType) => void }>;
const NATIVE_ANCHOR_STYLE = { width: 0, height: 0 } as const;
/** Home leads the shortcuts (owner 2026-11-04): the page the desktop opens on, one tap away on a phone. */
const HOME_ITEM_ID = 'phone-launcher:home';
/*
 * A Bot is a bar destination like any other (owner 11-06, lab mnBots A): Bar, More or none, through the same
 * placements (`phoneBotPlacementId`). It starts nowhere, since More's Bots entry already lists every Bot.
 */

/** One launcher row: a catalog destination, or a Bot from the roster's own projection. */
type LauncherEntry = Readonly<{ id: string; defaultPlacement: NavigationPlacement }> & (
    | Readonly<{ kind: 'destination'; destination: CompactAppDestination }>
    | Readonly<{ kind: 'bot'; bot: OrderedBot; name: string }>
);

function phoneLauncherDefaultPlacement(destination: CompactAppDestination): NavigationPlacement {
    // Contextual pages wait in Customize. Settings is a main screen like the others (owner 11-10): in More until pinned.
    return destination.contextual ? 'hidden' : 'overflow';
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

function phoneBarTab(entry: LauncherEntry, botsNeedsYou: number): CockpitTabBarTabDefinition<string> & Readonly<{ sfSymbol: string }> {
    if (entry.kind === 'bot') {
        const { bot } = entry;
        // The Bot's face is the slot, with the bar's own needs-you dot. UIKit takes symbols only: there it is the Bots glyph.
        return { id: entry.id, label: entry.name, sfSymbol: sfSymbolForCockpitTabIcon(BOTS_GLYPH),
            icon: { render: ({ size }) => <SessionBotFace facts={bot.face} size={size} mood={bot.activity} motion /> },
            badge: bot.activity === 'needsYou' ? { kind: 'attention' } : undefined,
            accessibilityLabel: orderedBotAccessibilityLabel(bot, entry.name) };
    }
    const { destination } = entry;
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
 * lists Home, what was placed in More, what is on the Bar under Pinned (to open or take off, owner 11-10),
 * then Customize. More is never replaced: the open destination, when it is not on the Bar, rides it just
 * before More. UIKit and the custom bar consume the same Bar items. Rows, availability and activation come
 * from the one destination catalog.
 */
const styles = StyleSheet.create((theme) => ({
    // A row's fact (badge, Bots faces) and its pin share one line.
    rowEnd: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
}));

export function usePhoneDestinationsMore(input: Readonly<{ native: boolean; main?: PhoneMainTabs }>) {
    const settingsMetrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    const { destinations, currentId, activate } = useColumnDestinations(undefined);
    const pluginPages = usePluginAppPagesMenu();
    const placement = useNavigationSurfacePlacement('phoneLauncher');
    const openHome = useOpenPhoneHome();
    const onHome = useDestinationPathname() === PHONE_HOME_ROUTE;
    const [open, setOpen] = React.useState(false);
    // A held tab's menu: a kept destination moves or hides; a main tab moves between the bar and More.
    const [tabMenu, setTabMenu] = React.useState<Readonly<{ id: string; label: string; open: boolean }> | null>(null);
    // The Bots' projection is read only while a Bot is placed or a menu that lists them is open.
    const botPlaced = React.useMemo(() => Object.entries(placement.preferences.placements)
        .some(([id, place]) => isPhoneBotPlacementId(id) && place !== 'hidden'), [placement.preferences]);
    const bots = useOrderedBots(open || tabMenu !== null || botPlaced);
    const botNames = useOrderedBotNames(bots);
    const navigateToSession = useNavigateToSession();
    const entries = React.useMemo((): readonly LauncherEntry[] => {
        const kept = phoneLauncherOrder(destinations).map((destination): LauncherEntry => ({
            kind: 'destination', id: destination.id, destination, defaultPlacement: phoneLauncherDefaultPlacement(destination),
        }));
        // A stable order (the roster's is by activity): a Bot on the bar never moves on its own.
        const botEntries = bots.map((bot, index) => ({
            kind: 'bot' as const, id: phoneBotPlacementId(bot), bot, name: botNames[index] ?? '', defaultPlacement: 'hidden' as const,
        })).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
        // Each Bot follows the Bots entry.
        const roster = kept.findIndex(entry => entry.kind === 'destination' && entry.destination.activation === 'botsRoster');
        const at = roster < 0 ? kept.length : roster + 1;
        return [...kept.slice(0, at), ...botEntries, ...kept.slice(at)];
    }, [botNames, bots, destinations]);
    const placed = React.useMemo(() => resolveNavigationPlacements(entries, placement.preferences), [entries, placement.preferences]);
    // The bar's own tabs: the same placement owner and preferences, pinned until the person moves one to More.
    const mainKeys = useMainAppTabKeys();
    const mainPlaced = React.useMemo(() => resolveNavigationPlacements(mainKeys.map((key) => ({
        id: `${MAIN_TAB_PLACEMENT_PREFIX}${key}`, key, defaultPlacement: 'pinned' as const, allowedPlacements: MAIN_TAB_PLACEMENTS,
    })), placement.preferences), [mainKeys, placement.preferences]);
    const mainActiveId = input.main?.activeId ?? null;
    const mainTabKeys = React.useMemo(() => mainPlaced.ordered
        .filter((entry) => mainPlaced.effectivePlacements[entry.id] === 'pinned').map((entry) => entry.key), [mainPlaced]);
    // The open item that waits in More, a main tab or a destination, rides the bar last, just before More:
    // the one visitor rule every phone bar uses (resolveNavigationVisitor).
    const visitorEntry = React.useMemo(() => {
        type Entry = Readonly<{ kind: 'main'; key: TabType } | { kind: 'destination'; entry: LauncherEntry }>;
        const main = (key: TabType): Entry => ({ kind: 'main', key });
        const destination = (entry: LauncherEntry): Entry => ({ kind: 'destination', entry });
        // The open item is the launcher destination on screen when there is one, otherwise the open main tab
        // (the catalog also names main tabs' pages, which are not launcher destinations).
        const onDestination = placed.ordered.some(entry => entry.kind === 'destination' && entry.destination.id === currentId);
        const isOpen = (item: Entry) => onDestination
            ? item.kind === 'destination' && item.entry.kind === 'destination' && item.entry.destination.id === currentId
            : item.kind === 'main' && item.key === mainActiveId;
        return resolveNavigationVisitor([...mainTabKeys.map(main), ...placed.pinned.map(destination)],
            [...mainPlaced.ordered.map(entry => main(entry.key)), ...placed.ordered.map(destination)], isOpen);
    }, [currentId, mainActiveId, mainPlaced, mainTabKeys, placed]);
    const mainVisitorKey = visitorEntry?.kind === 'main' ? visitorEntry.key : null;
    const visitor = visitorEntry?.kind === 'destination' ? visitorEntry.entry : null;
    const onBar = React.useMemo(() => visitor ? [...placed.pinned, visitor] : placed.pinned, [placed, visitor]);
    const { needsYou } = useBotsSummary(onBar.some(entry => entry.kind === 'destination' && entry.destination.activation === 'botsRoster'));
    const barTabs = React.useMemo(() => onBar.map((entry) => phoneBarTab(entry, needsYou)), [onBar, needsYou]);
    const pinnedTitle = t('phoneNav.bar.pinnedSection');
    const categoryTitles = React.useMemo(() => ({ onBar: pinnedTitle }), [pinnedTitle]);

    const items = React.useMemo((): readonly DropdownMenuItem[] => {
        // More dims unavailable shortcuts; the bar keeps the reason for an explicitly pinned one.
        const item = (destination: CompactAppDestination, pinned: boolean): DropdownMenuItem => {
            const fact = destination.kind === 'plugin' && destination.badge
                ? <CompactAppDestinationBadge destination={destination} />
                // The phone's one Bots entry carries the faces and what needs you (lab b-rail Ap).
                : destination.activation === 'botsRoster' ? <BotsEntrySummary /> : undefined;
            return {
                id: destination.id,
                testID: destinationRowTestId(destination),
                title: destination.title,
                category: pinned ? 'onBar' : 'more',
                icon: <Icon name={destination.icon} />,
                // Pins mount only while More is open: a closed More holds no per-row settings writers.
                rightElement: open ? <View style={styles.rowEnd}>
                    {fact}
                    <NavigationPlacementPinButton surfaceId="phoneLauncher" entryId={destination.id} pinned={pinned}
                        label={t(pinned ? 'phoneNav.bar.removeFromBar' : 'phoneNav.bar.keepOnBar')} preferences={placement.preferences}
                        testID={`phone-launcher-pin:${destination.id}`} />
                </View> : fact,
                checked: destination.id === currentId,
                disabled: destination.availability !== 'available',
            };
        };
        // A Bot's row: its face and name, with the same pin.
        const botItem = (entry: Extract<LauncherEntry, { kind: 'bot' }>, pinned: boolean): DropdownMenuItem => ({
            id: entry.id, testID: `phone-launcher-bot:${entry.id}`, title: entry.name, category: pinned ? 'onBar' : 'more',
            icon: <SessionBotFace facts={entry.bot.face} size={ICON_SIZE.md} mood={entry.bot.activity} motion />,
            rightElement: open ? <NavigationPlacementPinButton surfaceId="phoneLauncher" entryId={entry.id} pinned={pinned}
                label={t(pinned ? 'phoneNav.bar.removeFromBar' : 'phoneNav.bar.keepOnBar')} preferences={placement.preferences}
                testID={`phone-launcher-pin:${entry.id}`} /> : undefined,
        });
        const entryItem = (entry: LauncherEntry, pinned: boolean) => entry.kind === 'bot' ? botItem(entry, pinned) : item(entry.destination, pinned);
        // The bar's own tabs list beside the destinations: open, and pinned or taken off the bar.
        const mainItem = (key: TabType, pinned: boolean): DropdownMenuItem => {
            const facts = resolveMainAppTabFacts(key);
            const id = `${MAIN_TAB_PLACEMENT_PREFIX}${key}`;
            return {
                id: `${MAIN_TAB_ITEM_PREFIX}${key}`, testID: `${MAIN_TAB_ITEM_PREFIX}${key}`, title: facts.label,
                category: pinned ? 'onBar' : 'more', icon: <Icon name={facts.icon} />, checked: mainActiveId === key,
                rightElement: open ? <NavigationPlacementPinButton surfaceId="phoneLauncher" entryId={id} pinned={pinned}
                    label={t(pinned ? 'phoneNav.bar.removeFromBar' : 'phoneNav.bar.keepOnBar')} preferences={placement.preferences}
                    testID={`phone-launcher-pin:${id}`} /> : undefined,
            };
        };
        return [
            { id: HOME_ITEM_ID, testID: 'phone-launcher-home', title: t('common.home'), category: 'home',
                icon: <Icon name="house" />, checked: onHome },
            ...mainPlaced.overflow.map((entry) => mainItem(entry.key, false)),
            ...placed.overflow.map((entry) => entryItem(entry, false)),
            ...mainPlaced.pinned.map((entry) => mainItem(entry.key, true)),
            ...placed.pinned.map((entry) => entryItem(entry, true)),
            { id: CUSTOMIZE_ITEM_ID, testID: 'phone-launcher-customize', title: t('navigationPlacement.customize'),
                category: 'customize', icon: <Icon name="sliders-horizontal" /> },
            ...(pluginPages.item ? [{ ...pluginPages.item, category: 'recovery' }] : []),
        ];
    }, [currentId, mainActiveId, mainPlaced, onHome, open, placed, placement.preferences, pluginPages.item]);

    const select = React.useCallback((id: string) => {
        setOpen(false);
        if (pluginPages.select(id)) return;
        if (id === HOME_ITEM_ID) {
            openHome();
            return;
        }
        if (id.startsWith(MAIN_TAB_ITEM_PREFIX)) {
            const key = mainKeys.find((candidate) => `${MAIN_TAB_ITEM_PREFIX}${candidate}` === id);
            if (key) input.main?.onTabPress(key);
            return;
        }
        if (id === CUSTOMIZE_ITEM_ID) {
            const customizable = [...mainKeys.map((key) => ({ id: `${MAIN_TAB_PLACEMENT_PREFIX}${key}`,
                title: resolveMainAppTabFacts(key).label, icon: resolveMainAppTabFacts(key).icon,
                defaultPlacement: 'pinned' as const, allowedPlacements: MAIN_TAB_PLACEMENTS })), ...entries.map((entry) => entry.kind === 'bot'
                ? { id: entry.id, title: entry.name, defaultPlacement: entry.defaultPlacement,
                    glyph: <SessionBotFace facts={entry.bot.face} size={ICON_SIZE.md} mood={entry.bot.activity} motion /> }
                : { id: entry.id, title: entry.destination.title, icon: entry.destination.icon, defaultPlacement: entry.defaultPlacement })];
            fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ NavigationPlacementCustomizer }) => {
                Modal.show({ component: NavigationPlacementCustomizer,
                    props: { surfaceId: 'phoneLauncher', items: customizable, testID: 'phone-launcher-customizer',
                        placementLabels: { pinned: t('navigationPlacement.bar') },
                        description: t('navigationPlacement.phoneBarDescription') } });
            }), { tag: 'PhoneDestinationsMenu.customize' });
            return;
        }
        const bot = entries.find((entry) => entry.kind === 'bot' && entry.id === id);
        if (bot?.kind === 'bot') {
            void navigateToSession(bot.bot.sessionId, { serverId: bot.bot.serverId });
            return;
        }
        const destination = destinations.find((candidate) => candidate.id === id);
        if (!destination || destination.availability !== 'available') return;
        const scope = captureActiveServerAccountScopeLifetime()?.scope ?? null;
        activate(destination, { searchScope: scope ? {
            accountId: scope.accountId, serverId: scope.serverId, sessionId: null, machineId: null, rootPath: null,
        } : undefined });
    }, [activate, destinations, entries, input.main, mainKeys, navigateToSession, openHome, pluginPages.select]);

    const openMenu = React.useCallback(() => setOpen(true), []);
    const available = destinations.length > 0;
    const tabAnchor = React.useRef<unknown>(null);
    const holdTab = React.useCallback((id: string, anchor: unknown, label: string) => {
        tabAnchor.current = anchor;
        setTabMenu({ id, label, open: true });
    }, []);
    const closeTabMenu = React.useCallback((next: boolean) => {
        if (!next) setTabMenu(current => current && { ...current, open: false });
    }, []);
    const heldEntry = tabMenu ? entries.find((entry) => entry.id === tabMenu.id) : undefined;
    const renderMenu = (metrics: TabBarMetrics) => !available ? null : <>
        {tabMenu ? <NavigationPlacementTabMenu testID="phone-launcher-tab-menu" address="phoneLauncher" preferences={placement.preferences}
            item={heldEntry
                ? { id: heldEntry.id, title: heldEntry.kind === 'bot' ? heldEntry.name : heldEntry.destination.title, defaultPlacement: heldEntry.defaultPlacement }
                : { id: `${MAIN_TAB_PLACEMENT_PREFIX}${tabMenu.id}`, title: tabMenu.label, defaultPlacement: 'pinned', allowedPlacements: MAIN_TAB_PLACEMENTS }}
            open={tabMenu.open} anchorRef={tabAnchor} onOpenChange={closeTabMenu} onCustomize={() => select(CUSTOMIZE_ITEM_ID)} /> : null}
        <DropdownMenu
            testID="phone-launcher-menu"
            open={open}
            onOpenChange={setOpen}
            items={items}
            categoryTitles={categoryTitles}
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
        bar: { tabs: barTabs, mainTabKeys, mainVisitorKey, onPress: select, ...(input.native || !available ? {} : { onTabLongPress: holdTab }) } };
}

/** The floating main bar with the phone's destinations: the tabs, the Bar items, then More. */
export const PhoneMainAppTabBar = React.memo(function PhoneMainAppTabBar(
    props: Omit<React.ComponentProps<typeof MainAppTabBar>, 'destinations' | 'more'>,
) {
    const activeId = props.selectedDestinationId ?? props.activeTab;
    const main = React.useMemo(() => ({ activeId, onTabPress: props.onTabPress }), [activeId, props.onTabPress]);
    const destinations = usePhoneDestinationsMore({ native: false, main });
    return <MainAppTabBar {...props} destinations={destinations.bar} more={destinations.available ? destinations.renderMenu : undefined} />;
});
