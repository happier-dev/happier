import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { useActivateAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { WorkspaceDestinationRow } from '@/components/appShell/workspace/WorkspaceDestinationRow';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { ActionListSection } from '@/components/ui/lists/ActionListSection';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { Modal } from '@/modal';
import { resolveNavigationOverflow, resolveNavigationPlacements, type NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { describeUpdatesEntry, UpdatesPopoverButton } from '@/components/updates/UpdatesPopoverButton';
import { useSharedInboxSummary } from '@/hooks/inbox/useInboxSummary';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { useNavigateToSession } from '@/hooks/session/useNavigateToSession';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import { useSharedUpdatesSummary } from '@/updates/useUpdatesSummary';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { SidebarFooterPopoverButton, type SidebarFooterPopoverContentProps, type SidebarFooterPopoverTrigger } from '../sidebarFooter/SidebarFooterPopoverButton';
import { SidebarUsagePopoverContent } from '../sidebarFooter/SidebarUsagePopoverContent';
import { RAIL_POPOVER_WIDE_WIDTH_PX } from '../sidebarFooter/sidebarFooterLayout';
import { InboxPopoverContent } from '@/components/inbox/InboxPopover';
import { AppRailAccount } from './AppRailAccount';
import { AppRailMachines } from './AppRailMachines';
import { AppRailBotMenuIcon, AppRailBotPin, AppRailBots, useAppRailBotHomes } from './AppRailBots';
import {
    APP_RAIL_ICON_GLYPH_SIZE_PX,
    APP_RAIL_ITEM_EDGES_PX,
    APP_RAIL_ITEM_SIZE_PX,
    APP_RAIL_ITEM_SLOT_PX,
    APP_RAIL_WIDTH_PX,
} from './appRailMetrics';
import { AppRailBadge, AppRailMenuCount, resolveAppRailBadgeTone } from './AppRailBadge';
import { AppRailIcon } from './AppRailIcon';
import { AppRailSlot } from './AppRailSlot';
import { useConnectedAccountsNeedingSignInCount } from './useConnectedAccountsNeedingSignInCount';
import { AppRailPeek } from './AppRailPeek';
import { AppRailHoverScope } from './AppShellPeek';
import {
    buildAppRailEntries,
    buildAppRailPlacementItems,
    resolveAppRailEntryColumn,
    type AppRailBotEntry,
    type AppRailEntry,
    type AppRailEntries,
    type AppRailPlacementItem,
} from './appRailModel';
import { useAppShellLocation } from './useAppShellLocation';
import { useSessionListRailOrganizationAction } from '@/components/sessions/shell/useSessionListRailOrganizationAction';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { moveAppRailBot } from './useAppRailBotReorder';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { usePaneRegionFocusBoundary } from '@/components/appShell/panes/paneRegion';

/** A rail-pinned Bot, standing right under the Bots entry among the top items. */
type AppRailTopGroup = AppRailPlacementItem['group'] | 'bots';
type WithTopGroup<T> = T extends unknown ? Omit<T, 'group'> & Readonly<{ group: AppRailTopGroup }> : never;
type AppRailTopItem =
    | WithTopGroup<AppRailPlacementItem>
    | Readonly<{ kind: 'botPin'; id: string; group: 'bots'; bot: AppRailBotEntry }>;

const renderUsageIcon = (open: boolean) => <AppRailIcon name="speedometer" active={open} />;
const renderUsage = (content: SidebarFooterPopoverContentProps) => <SidebarUsagePopoverContent {...content} />;

/**
 * The app's rail (lab `xrail-R1`): every destination as an icon, the open one filled. The app's own
 * destinations come first, then Plugins and the plugin destinations that asked for the navigation;
 * those that do not fit go into "More". At the bottom: Usage and Machines (their popovers, Usage's
 * only where connected-account limits are reported), Updates
 * while one exists, Settings and the person, whose Home/account popover opens from the avatar.
 */
export const AppRail = React.memo(function AppRail() {
    const focusBoundary = usePaneRegionFocusBoundary('rail', true);
    const { catalog, location } = useAppShellLocation();
    const botHomes = useAppRailBotHomes();
    const botHomeIds = React.useMemo(() => botHomes.map(home => home.serverId), [botHomes]);
    useSessionListRailOrganizationAction(botHomeIds);
    const entries = React.useMemo(() => buildAppRailEntries(catalog, { includeHidden: true, botHomes }), [botHomes, catalog]);
    const { preferences } = useNavigationSurfacePlacement('appRail');
    const updatesVisible = describeUpdatesEntry(useSharedUpdatesSummary()) !== null;
    const activeId = location.railEntryId;
    const open = useActivateAppDestination();

    const items = React.useMemo(() => buildAppRailPlacementItems(entries, updatesVisible), [entries, updatesVisible]);
    const customize = React.useCallback(() => {
        fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ NavigationPlacementCustomizer }) => {
            Modal.show({ component: NavigationPlacementCustomizer,
                props: { surfaceId: 'appRail', items, testID: 'app-rail-customizer' } });
        }), { tag: 'AppRail.customize' });
    }, [items]);
    return <AppRailSurface entries={entries} activeId={activeId} onOpen={open} preferences={preferences}
        updatesVisible={updatesVisible} onCustomize={customize} focusBoundary={focusBoundary} />;
});

/** The real rail composition, shared by the shell and its fixture preview. */
export const AppRailSurface = React.memo(function AppRailSurface(props: Readonly<{
    entries: AppRailEntries;
    activeId: string | null;
    onOpen: (entry: AppRailEntry) => void;
    preferences?: NavigationPlacementPreferences;
    updatesVisible?: boolean;
    onCustomize?: () => void;
    /** Static previews replace only the effectful footer boundary, using the same rail composition. */
    renderFooter?: (item: AppRailPlacementItem, renderTrigger?: SidebarFooterPopoverTrigger) => React.ReactNode;
    focusBoundary?: ReturnType<typeof usePaneRegionFocusBoundary>;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const { entries, activeId, onOpen: open } = props;
    const botNeighbors = React.useMemo(() => {
        const byHome = new Map<string, AppRailBotEntry[]>();
        for (const bot of entries.bots) byHome.set(bot.serverId, [...(byHome.get(bot.serverId) ?? []), bot]);
        const neighbors = new Map<string, { previous?: string; next?: string }>();
        for (const bots of byHome.values()) bots.forEach((bot, index) => neighbors.set(bot.id, {
            previous: bots[index - 1]?.sessionId, next: bots[index + 1]?.sessionId,
        }));
        return neighbors;
    }, [entries.bots]);

    const [availableHeight, setAvailableHeight] = React.useState<number | null>(null);
    const onRailLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = Math.max(0, event.nativeEvent.layout.height - RAIL_PADDING_TOP_PX - RAIL_PADDING_BOTTOM_PX);
        setAvailableHeight(current => current === height ? current : height);
    }, []);
    const items = React.useMemo(() => buildAppRailPlacementItems(entries, props.updatesVisible === true), [entries, props.updatesVisible]);
    const placements = resolveNavigationPlacements(items, props.preferences);
    // Bots pinned to the rail stand right under the one Bots entry, in the person's order (60s3). A pin
    // is its own explicit placement: when the Bots entry is in overflow or hidden, the pins close the top.
    const botPins = entries.bots.map((bot): AppRailTopItem => ({ kind: 'botPin', id: bot.id, group: 'bots', bot }));
    const isBotsEntry = (item: AppRailPlacementItem) => item.kind === 'destination' && item.entry.activation === 'botsRoster';
    const topItems = placements.pinned.filter(item => item.group !== 'account');
    const top: AppRailTopItem[] = [
        // The Bots entry and its pins stand apart, a hairline above them (lab `b-rail A`).
        ...topItems.flatMap((item): AppRailTopItem[] => isBotsEntry(item) ? [{ ...item, group: 'bots' as const }, ...botPins] : [item]),
        ...(topItems.some(isBotsEntry) ? [] : botPins),
    ];
    const bottom = placements.pinned.filter(item => item.group === 'account');
    // The anchored group has priority when space is short. Giving it the first top group's
    // geometry avoids counting a divider between the footer and the top: only top groups divide.
    const priority: AppRailTopItem[] = [...bottom.map(item => ({ ...item, group: top[0]?.group ?? 'app' })), ...top];
    const fitted = resolveNavigationOverflow<AppRailTopItem>(priority, placements.overflow, {
        availableSize: availableHeight, itemSize: APP_RAIL_ITEM_SLOT_PX, separatorSize: RAIL_SEPARATOR_SIZE_PX,
    });
    const shownIds = new Set(fitted.shown.map(item => item.id));
    const shownTop = top.filter(item => shownIds.has(item.id));
    const shownBottom = bottom.filter(item => shownIds.has(item.id));
    const overflowIds = new Set(fitted.overflow.map(item => item.id));
    const overflow = placements.ordered.filter(item => overflowIds.has(item.id));
    // A measured overflow keeps every rail-pinned Bot reachable in More.
    const overflowBots = entries.bots.filter(bot => overflowIds.has(bot.id));
    // Pins already there when the rail mounts stand still; only a newly accepted pin lands.
    const seenBotIdsRef = React.useRef<ReadonlySet<string> | null>(null);
    const seenBotIds = seenBotIdsRef.current;
    React.useEffect(() => {
        seenBotIdsRef.current = new Set([...(seenBotIdsRef.current ?? []), ...entries.bots.map(bot => bot.id)]);
    }, [entries.bots]);
    const renderFooter = props.renderFooter ?? ((item: AppRailPlacementItem, trigger?: SidebarFooterPopoverTrigger) =>
        <AppRailFooterItem item={item} renderTrigger={trigger} activeId={activeId} />);

    // The rail is a dock: its popovers and its column peeks answer one hover intent.
    return (<AppRailHoverScope>
        <View testID="app-rail" style={[styles.rail, { backgroundColor: materialColor(theme.colors.background.canvas, 'transparent') }]} onLayout={onRailLayout}
            ref={props.focusBoundary?.ref} onFocus={props.focusBoundary?.onFocus}
            focusable={props.focusBoundary ? true : undefined} accessibilityLabel={props.focusBoundary ? t('settingsKeyboard.paneRegions.rail') : undefined}
            {...(Platform.OS === 'web' && props.focusBoundary ? { role: 'navigation' as const, tabIndex: -1, onFocusCapture: props.focusBoundary.onFocusCapture } : null)}
            {...(Platform.OS === 'web' ? { onContextMenu: (event: { preventDefault: () => void }) => { event.preventDefault(); props.onCustomize?.(); } } : null)}
            >
            <View testID="app-rail-destinations" style={styles.topArea}>
                {shownTop.map((item, index) => <React.Fragment key={item.id}>
                    {index > 0 && shownTop[index - 1]?.group !== item.group ? <View style={styles.separator} /> : null}
                    {item.kind === 'botPin'
                        ? <AppRailBotPin bot={item.bot}
                            previousBotSessionId={botNeighbors.get(item.id)?.previous}
                            nextBotSessionId={botNeighbors.get(item.id)?.next}
                            animateEntry={seenBotIds !== null && !seenBotIds.has(item.id)} />
                        : item.kind === 'destination' ? <AppRailItem entry={item.entry} active={activeId === item.id} onOpen={open}
                            onCustomize={props.onCustomize} /> : null}
                </React.Fragment>)}
                {overflow.length > 0 || overflowBots.length > 0 || (fitted.shown.length === 0 && items.length > 0 && props.onCustomize) ? (
                    <AppRailMore
                        entries={overflow}
                        bots={overflowBots}
                        botNeighbors={botNeighbors}
                        active={overflow.some((entry) => entry.id === activeId)}
                        onOpen={open}
                        onCustomize={props.onCustomize}
                        renderFooter={renderFooter}
                    />
                ) : null}
            </View>
            <View testID="app-rail-bottom" style={styles.group}>
                {shownBottom.map(item => item.kind === 'destination'
                    ? <AppRailItem key={item.id} entry={item.entry} active={activeId === item.id} onOpen={open} onCustomize={props.onCustomize} />
                    : <React.Fragment key={item.id}>{renderFooter(item)}</React.Fragment>)}
            </View>
        </View>
    </AppRailHoverScope>);
});

const AppRailItem = React.memo(function AppRailItem(props: Readonly<{
    entry: AppRailEntry;
    active: boolean;
    onOpen: (entry: AppRailEntry) => void;
    onCustomize?: () => void;
}>) {
    const styles = stylesheet;
    const { entry } = props;
    const shortcut = useKeyboardShortcutLabel(entry.kind === 'builtin' ? entry.shortcut : undefined);
    const tooltip = shortcut ? `${entry.title}  ${shortcut}` : entry.title;
    const unavailable = entry.availability !== 'available';
    const column = resolveAppRailEntryColumn(entry);
    // A plugin destination's static badge ("Beta") has no room for text on the rail: it marks the icon.
    const pluginBadge = entry.kind === 'plugin' ? entry.badge ?? null : null;
    if (entry.activation === 'botsRoster' && !unavailable) {
        return <AppRailBots entry={entry} />;
    }
    // Lab `inbox-I2`: the Inbox answers from beside the rail; the page is one "Open Inbox" away, and the
    // icon of the Inbox already on screen simply stays on it.
    if (entry.kind === 'builtin' && entry.signal === 'inboxCount' && !unavailable && !props.active) {
        return <AppRailInbox entry={entry} onOpenPage={props.onOpen} />;
    }
    const button = (peeks: boolean) => (
        <IconButton
            testID={`app-rail:${entry.id}`}
            variant="plain"
            size={APP_RAIL_ITEM_SIZE_PX}
            interactiveTargetEdgesPx={APP_RAIL_ITEM_EDGES_PX}
            accessibilityLabel={entry.title}
            // Where resting on the icon peeks its column, the column says what it is.
            tooltip={peeks ? undefined : tooltip}
            tooltipPlacement="right"
            selected={props.active}
            disabled={unavailable}
            disabledReason={describeUnavailableBuiltin(entry)}
            icon={<AppRailIcon name={entry.icon} active={props.active} />}
            onPress={() => props.onOpen(entry)}
            onLongPress={props.onCustomize}
        />
    );
    const badge = entry.kind === 'builtin' && entry.signal === 'inboxCount'
        ? <AppRailInboxBadge testID={`app-rail:${entry.id}-badge`} />
        : pluginBadge ? (
            <AppRailBadge
                testID={`app-rail:${entry.id}-badge`}
                signal={{ kind: 'dot', tone: resolveAppRailBadgeTone({ source: 'plugin', tone: pluginBadge.tone }) }}
            />
        ) : null;
    return (
        <AppRailSlot badge={badge}
            href={!unavailable && entry.activation === 'navigate' ? entry.routePath : null}>
            {column
                ? <AppRailPeek testID={`app-rail-peek:${entry.id}`} destinationId={entry.id}>{button}</AppRailPeek>
                : button(false)}
        </AppRailSlot>
    );
});

function describeUnavailableBuiltin(entry: AppRailEntry): string | undefined {
    return entry.kind === 'builtin' && entry.availability !== 'available'
        ? t('settingsActions.reasons.notAvailableInThisApp') : undefined;
}

/** The width the Inbox popover's rows need for a title, its line and an inline answer (lab `inbox-I2`). */
const INBOX_POPOVER_WIDTH_PX = 400;

const AppRailInbox = React.memo(function AppRailInbox(props: Readonly<{
    entry: AppRailEntry;
    onOpenPage: (entry: AppRailEntry) => void;
}>) {
    const styles = stylesheet;
    const { entry, onOpenPage } = props;
    const openPage = React.useCallback(() => onOpenPage(entry), [entry, onOpenPage]);
    const renderContent = React.useCallback((content: SidebarFooterPopoverContentProps) => (
        <InboxPopoverContent close={content.close} onOpenInbox={openPage} />
    ), [openPage]);
    const renderIcon = React.useCallback((open: boolean) => <AppRailIcon name={entry.icon} active={open} />, [entry.icon]);
    return (
        <AppRailSlot href={entry.routePath} badge={<AppRailInboxBadge testID={`app-rail:${entry.id}-badge`} />}>
            <SidebarFooterPopoverButton
                testID={`app-rail:${entry.id}`}
                iconName={entry.icon}
                label={entry.title}
                placement="right"
                anchorAlignVertical="start"
                buttonSizePx={APP_RAIL_ITEM_SIZE_PX}
                interactiveTargetEdgesPx={APP_RAIL_ITEM_EDGES_PX}
                iconSizePx={APP_RAIL_ICON_GLYPH_SIZE_PX}
                popoverWidthPx={INBOX_POPOVER_WIDTH_PX}
                renderContent={renderContent}
                renderIcon={renderIcon}
            />
        </AppRailSlot>
    );
});

/** The Inbox count: read only by this leaf, so a new item re-renders the badge and nothing else. */
const AppRailInboxBadge = React.memo(function AppRailInboxBadge(props: Readonly<{ testID: string }>) {
    const summary = useSharedInboxSummary();
    if (summary.count !== null && summary.count <= 0) return null;
    return (
        <AppRailBadge
            testID={props.testID}
            signal={summary.count === null ? { kind: 'dot', tone: resolveAppRailBadgeTone({ source: 'inbox' }) }
                : { kind: 'count', value: summary.count, tone: resolveAppRailBadgeTone({ source: 'inbox' }) }}
        />
    );
});

const AppRailMore = React.memo(function AppRailMore(props: Readonly<{
    entries: readonly AppRailPlacementItem[];
    bots?: readonly AppRailBotEntry[];
    botNeighbors: ReadonlyMap<string, { previous?: string; next?: string }>;
    active: boolean;
    onOpen: (entry: AppRailEntry) => void;
    onCustomize?: () => void;
    renderFooter: (item: AppRailPlacementItem, renderTrigger?: SidebarFooterPopoverTrigger) => React.ReactNode;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    // Keyboard selection and a row press invoke the same current mounted More presentation.
    // Footer triggers and Bot commands stay here only; this map never resolves an Action or an order.
    const footerActions = React.useRef(new Map<string, () => void>());
    const registerFooterAction = React.useCallback((id: string, action: (() => void) | null) => {
        if (action) footerActions.current.set(id, action);
        else footerActions.current.delete(id);
    }, []);
    const wrapItem = React.useCallback((item: Readonly<{ id: string }>, children: React.ReactNode) => {
        const entry = props.entries.find(candidate => candidate.id === item.id);
        if (entry?.kind === 'footer') return props.renderFooter(entry, state => <AppRailFooterMenuRow
            item={entry} trigger={state} registerAction={registerFooterAction} />);
        return <WorkspaceDestinationRow href={entry?.kind === 'destination' && entry.entry.availability === 'available' && entry.entry.activation === 'navigate'
            ? entry.entry.routePath : null}>{children}</WorkspaceDestinationRow>;
    }, [props.entries, props.renderFooter, registerFooterAction]);
    const navigateToSession = useNavigateToSession();
    const botHomeIds = React.useMemo(() => [...new Set((props.bots ?? []).map(bot => bot.serverId))], [props.bots]);
    const botScopes = useServerCredentialAccountScopeBindings(botHomeIds);
    const botItems = (props.bots ?? []).map((bot): DropdownMenuItem => ({
        id: bot.id,
        testID: `app-rail-more:${bot.id}`,
        title: getSessionName(bot.session, bot.serverId),
        icon: <AppRailBotMenuIcon bot={bot} size={MENU_ROW_METRICS.iconGlyphSizePx + 2} />,
        submenu: { items: [
            { id: bot.id, title: t('common.open') },
            ...(props.botNeighbors.get(bot.id)?.previous ? [{ id: `move-up:${bot.id}`, title: t('common.moveUp'), disabled: !botScopes.get(bot.serverId)?.isCurrent() }] : []),
            ...(props.botNeighbors.get(bot.id)?.next ? [{ id: `move-down:${bot.id}`, title: t('common.moveDown'), disabled: !botScopes.get(bot.serverId)?.isCurrent() }] : []),
        ] },
    }));
    const items = [...botItems, ...props.entries.map((entry): DropdownMenuItem => ({
        id: entry.id,
        testID: `app-rail-more:${entry.id}`,
        title: entry.title,
        subtitle: entry.kind === 'destination' ? describeUnavailableBuiltin(entry.entry) : undefined,
        icon: <Icon name={entry.icon} size={MENU_ROW_METRICS.iconGlyphSizePx} color={theme.colors.text.secondary} />,
        disabled: entry.kind === 'destination' && entry.entry.availability !== 'available',
    }))];
    return (
        <AppRailSlot>
            {botHomeIds.map(serverId => <AppRailBotOverflowActions key={serverId} serverId={serverId}
                bots={props.bots ?? []} neighbors={props.botNeighbors} registerAction={registerFooterAction} />)}
            <DropdownMenu
                testID="app-rail-more"
                open={open}
                onOpenChange={setOpen}
                items={items}
                emptyLabel={null}
                wrapItem={wrapItem}
                closeOnSelect={false}
                footer={<>
                    {props.onCustomize ? <ActionListSection separatorAbove actions={[{ id: 'customize', testID: 'app-rail-more.customize',
                        label: t('navigationPlacement.customize'), onPress: () => { setOpen(false); props.onCustomize?.(); } }]} /> : null}
                </>}
                onSelect={(id) => {
                    const direction = id.startsWith('move-up:') ? 'up' : id.startsWith('move-down:') ? 'down' : null;
                    if (direction) {
                        footerActions.current.get(id)?.();
                        return;
                    }
                    const bot = props.bots?.find(candidate => candidate.id === id);
                    if (bot) {
                        setOpen(false);
                        void navigateToSession(bot.sessionId, { serverId: bot.serverId });
                        return;
                    }
                    const entry = props.entries.find((candidate) => candidate.id === id);
                    if (entry?.kind === 'destination') { setOpen(false); props.onOpen(entry.entry); }
                    else footerActions.current.get(id)?.();
                }}
                placement="right"
                variant="slim"
                matchTriggerWidth={false}
                popoverPortalWebTarget="body"
                trigger={({ toggle }) => (
                    <IconButton
                        testID="app-rail-more.trigger"
                        variant="plain"
                        size={APP_RAIL_ITEM_SIZE_PX}
                        interactiveTargetEdgesPx={APP_RAIL_ITEM_EDGES_PX}
                        accessibilityLabel={t('common.moreActions')}
                        tooltip={t('common.moreActions')}
                        tooltipPlacement="right"
                        tooltipHidden={open}
                        selected={props.active || open}
                        icon={<AppRailIcon name="dots-three" />}
                        onPress={toggle}
                        onLongPress={props.onCustomize}
                    />
                )}
            />
        </AppRailSlot>
    );
});

/** Keep each overflow Home's original result continuation mounted even while More is closed. */
function AppRailBotOverflowActions(props: Readonly<{
    serverId: string;
    bots: readonly AppRailBotEntry[];
    neighbors: ReadonlyMap<string, { previous?: string; next?: string }>;
    registerAction: (id: string, action: (() => void) | null) => void;
}>) {
    const { binding, execute } = useMountedActionExecution(props.serverId);
    React.useEffect(() => {
        const ids: string[] = [];
        for (const bot of props.bots) {
            if (bot.serverId !== props.serverId) continue;
            for (const direction of ['up', 'down'] as const) {
                const target = props.neighbors.get(bot.id)?.[direction === 'up' ? 'previous' : 'next'];
                if (!target) continue;
                const id = `move-${direction}:${bot.id}`;
                ids.push(id);
                props.registerAction(id, () => fireAndForget(
                    moveAppRailBot(binding, bot, target, direction === 'up' ? 'top' : 'bottom', execute),
                    { tag: 'AppRail.More.Bot.move' },
                ));
            }
        }
        return () => { for (const id of ids) props.registerAction(id, null); };
    }, [binding, execute, props.bots, props.neighbors, props.registerAction, props.serverId]);
    return null;
}

function AppRailFooterMenuRow(props: Readonly<{
    item: AppRailPlacementItem;
    trigger: Parameters<SidebarFooterPopoverTrigger>[0];
    registerAction: (id: string, action: (() => void) | null) => void;
}>) {
    const { theme } = useUnistyles();
    const { id } = props.item;
    const { onPress } = props.trigger;
    React.useEffect(() => {
        props.registerAction(id, onPress);
        return () => props.registerAction(id, null);
    }, [id, onPress, props.registerAction]);
    return <SelectableRow testID={`app-rail-more:${id}`} title={props.item.title} variant="slim" presentation="menu"
        onPress={onPress} selected={props.trigger.open} right={props.trigger.right}
        left={<Icon name={props.item.icon} size={MENU_ROW_METRICS.iconGlyphSizePx} color={theme.colors.text.secondary} />} />;
}

const AppRailFooterItem = React.memo(function AppRailFooterItem(props: Readonly<{
    item: AppRailPlacementItem;
    renderTrigger?: SidebarFooterPopoverTrigger;
    /** The open rail entry: a footer control whose destination is open shows selected (Machines' rail door). */
    activeId?: string | null;
}>) {
    if (props.item.id === 'app-rail-usage') return <AppRailUsage renderTrigger={props.renderTrigger} />;
    if (props.item.id === 'app-rail-machines') return <AppRailMachines renderTrigger={props.renderTrigger} selected={props.activeId === 'machines'} />;
    if (props.item.id === 'app-rail-updates') return <AppRailUpdates renderTrigger={props.renderTrigger} />;
    if (props.item.id === 'app-rail-account') {
        const account = <AppRailAccount renderTrigger={props.renderTrigger
            ? state => props.renderTrigger?.({ onPress: state.activate, open: state.open }) : undefined} />;
        return props.renderTrigger ? account : <AppRailSlot>{account}</AppRailSlot>;
    }
    return null;
});

const AppRailUsage = React.memo(function AppRailUsage(props: Readonly<{ renderTrigger?: SidebarFooterPopoverTrigger }>) {
    const router = useRouter();
    // The Usage popover previews connected-account limits where this Home reports them; the icon
    // itself is always there and otherwise opens the Usage page.
    const quotaMetersAvailable = useFeatureEnabled('connectedServices.quotas');
    // A red count only for accounts that need a new sign-in; low limits never badge (lab G2).
    const signInCount = useConnectedAccountsNeedingSignInCount();
    const menuTrigger: SidebarFooterPopoverTrigger | undefined = props.renderTrigger ? state => props.renderTrigger?.({ ...state,
        right: signInCount > 0 ? <AppRailMenuCount tone={resolveAppRailBadgeTone({ source: 'signIn' })} value={signInCount} /> : undefined,
    }) : undefined;
    const openUsage = React.useCallback(() => {
        const result = runGuardedNavigation(() => router.push(SETTINGS_ROUTES.usage as never));
        if (result !== true) fireAndForget(result, { tag: 'AppRail.usage' });
    }, [router]);
    const control = (
        <>
                {quotaMetersAvailable ? (
                    <SidebarFooterPopoverButton
                        testID="app-rail-usage"
                        iconName="speedometer"
                        renderIcon={renderUsageIcon}
                        label={t('settings.usage')}
                        placement="right"
                        buttonSizePx={APP_RAIL_ITEM_SIZE_PX}
                        interactiveTargetEdgesPx={APP_RAIL_ITEM_EDGES_PX}
                        iconSizePx={APP_RAIL_ICON_GLYPH_SIZE_PX}
                        popoverWidthPx={RAIL_POPOVER_WIDE_WIDTH_PX}
                        hoverPreview
                        renderContent={renderUsage}
                        renderTrigger={menuTrigger}
                    />
                ) : (
                    // Without connected-account limits there is nothing to preview: the icon opens Usage.
                    menuTrigger ? menuTrigger({ onPress: openUsage, open: false }) : <IconButton
                        testID="app-rail-usage"
                        variant="plain"
                        size={APP_RAIL_ITEM_SIZE_PX}
                        interactiveTargetEdgesPx={APP_RAIL_ITEM_EDGES_PX}
                        accessibilityLabel={t('settings.usage')}
                        tooltip={t('settings.usage')}
                        tooltipPlacement="right"
                        icon={<AppRailIcon name="speedometer" />}
                        onPress={openUsage}
                    />
                )}
        </>
    );
    if (props.renderTrigger) return <WorkspaceDestinationRow href={SETTINGS_ROUTES.usage}>{control}</WorkspaceDestinationRow>;
    return (
        <AppRailSlot href={SETTINGS_ROUTES.usage} badge={signInCount > 0 ? (
            <AppRailBadge
                testID="app-rail-usage-badge"
                signal={{ kind: 'count', value: signInCount, tone: resolveAppRailBadgeTone({ source: 'signIn' }) }}
            />
        ) : null}>
            {control}
        </AppRailSlot>
    );
});


const AppRailUpdates = React.memo(function AppRailUpdates(props: Readonly<{ renderTrigger?: SidebarFooterPopoverTrigger }>) {
    const updatesSummary = useSharedUpdatesSummary();
    const updatesCopy = describeUpdatesEntry(updatesSummary);
    const menuTrigger: SidebarFooterPopoverTrigger | undefined = props.renderTrigger ? state => props.renderTrigger?.({ ...state,
        right: updatesCopy?.count
            ? <AppRailMenuCount tone={resolveAppRailBadgeTone({ source: 'updates', failed: updatesCopy.warning })} value={updatesCopy.count} />
            : undefined,
    }) : undefined;
    const button = (
        <UpdatesPopoverButton
            summary={updatesSummary}
            variant="footer"
            buttonSize={APP_RAIL_ITEM_SIZE_PX}
            markSize={APP_RAIL_ICON_GLYPH_SIZE_PX}
            hostDrawsCount
            testID="app-rail-updates"
            renderTrigger={menuTrigger}
        />
    );
    if (props.renderTrigger) return button;
    return (
        <AppRailSlot badge={updatesCopy?.count ? (
            <AppRailBadge
                testID="app-rail-updates-badge"
                signal={{
                    kind: 'count',
                    value: updatesCopy.count,
                    tone: resolveAppRailBadgeTone({ source: 'updates', failed: updatesCopy.warning }),
                }}
            />
        ) : null}>
            {button}
        </AppRailSlot>
    );
});

const RAIL_PADDING_TOP_PX = 4;
const RAIL_PADDING_BOTTOM_PX = 12;
const RAIL_SEPARATOR_MARGIN_PX = 8;
const RAIL_SEPARATOR_SIZE_PX = RAIL_SEPARATOR_MARGIN_PX * 2 + StyleSheet.hairlineWidth;

const stylesheet = StyleSheet.create((theme) => ({
    rail: {
        flex: 1,
        width: APP_RAIL_WIDTH_PX,
        flexShrink: 0,
        minHeight: 0,
        alignItems: 'center',
        paddingTop: RAIL_PADDING_TOP_PX,
        paddingBottom: RAIL_PADDING_BOTTOM_PX,
        backgroundColor: theme.colors.background.canvas,
    },
    group: {
        alignItems: 'center',
        flexShrink: 0,
    },
    topArea: {
        flex: 1,
        minHeight: 0,
        alignItems: 'center',
        flexShrink: 0,
    },
    separator: {
        width: 24,
        height: StyleSheet.hairlineWidth,
        marginVertical: RAIL_SEPARATOR_MARGIN_PX,
        backgroundColor: theme.colors.border.default,
    },
}));
