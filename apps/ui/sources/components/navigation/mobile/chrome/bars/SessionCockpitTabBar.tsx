import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import * as React from 'react';
import { listPendingPermissionRequests } from '@/utils/sessions/sessionUtils';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import { storage, useSession, useSessionProjectScmStatus, useSetting } from '@/sync/domains/state/storage';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { SessionAgentCatalogIdentityIcon } from '@/components/sessions/presentation/SessionAgentCatalogIdentityIcon';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { resolveGitTabBadge } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import {
    resolveSessionCockpitMobileTabVisibility,
    resolveSessionCockpitPhoneItems,
    type SessionCockpitMobileCatalogEntry,
} from '@/components/workspaceCockpit/session/sessionCockpitMobileCatalog';
import { type NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { useDetailPageTabsPosition } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { type TabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { SessionCollaborationRailBadge } from '@/components/sessions/collaboration/sessionConversationAttention';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { PendingNavigationPill } from '@/components/sessions/pendingNavigation/PendingNavigationPill';
import { openSessionNavigationCustomizer, resolveSessionNavigationCustomizerProps } from '@/components/sessions/panes/sessionNavigationCustomizer';
import type { ResolveRightSidebarTabsInput } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';

import { useSessionSwitcherBand } from '../lateralSwipe/SessionSwitcherBand';
import { useSessionSwitcherInputEnabled } from '../lateralSwipe/useSessionSwitcherInputEnabled';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import {
    CockpitTabBar,
    CockpitTabBarView,
    CockpitTabBarActionView,
    type CockpitTabBarTabDefinition,
} from './CockpitTabBar';
import { PhonePageStripView } from './PhonePageStrip';
import { useDetailPhonePlacement, useDetailPhoneBarPresentation, type DetailPhonePreviewMetrics } from './detailPhoneNavigation';
import { sfSymbolForCockpitTabIcon } from './cockpitTabSymbols';

export type SessionCockpitTabBarProps = Readonly<{
    catalog: readonly SessionCockpitMobileCatalogEntry[];
    sessionId: string;
    /** Route server scope, so the capsule and the picker anchor on the same entry. */
    serverId?: string | null;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    openDetailsTabCount: number;
    pluginPlacements?: readonly PluginUiSurfacePlacementProjection[];
    /** The mounted Session's detail-list inputs: Customize resolves the desktop lists from them. */
    detailInput?: ResolveRightSidebarTabsInput;
    onSurfacePress: (surface: SessionMobileSurface) => void;
    onCustomize?: (props: import('@/components/ui/navigation/NavigationPlacementCustomizer').DetailNavigationCustomizerProps) => void;
}>;

export type SessionCockpitTabDefinition = CockpitTabBarTabDefinition<SessionMobileSurface> & Readonly<{ sfSymbol: string }>;

const PREVIOUS_SESSION_ACTION = 'previousSession';
const NEXT_SESSION_ACTION = 'nextSession';
const SWITCH_SESSION_ACTION = 'switchSession';
const ignorePreviewPress = () => {};

/** Placement-only specimen: captured descriptors, with no Session readers or live menu owners. */
function SessionCockpitTabBarPreview(props: Readonly<{
    catalog: readonly SessionCockpitMobileCatalogEntry[];
    tabs: readonly SessionCockpitTabDefinition[];
    preferences: NavigationPlacementPreferences;
    activeSurface: SessionMobileSurface;
    slotCount: number;
    alwaysSwipe: boolean;
    metrics: TabBarMetrics;
}>) {
    const { theme } = useUnistyles();
    const pageTabs = useDetailPageTabsPosition('session');
    const visibility = resolveSessionCockpitMobileTabVisibility({ ...props, pageTabs });
    const tabs = visibility.visible.flatMap(entry => props.tabs.filter(tab => tab.id === entry.id));
    const stripTabs = visibility.top.flatMap(entry => props.tabs.filter(tab => tab.id === entry.id));
    const bar = <CockpitTabBarView activeSurface={props.activeSurface} tabs={tabs}
        barTestId="session-cockpit-preview" tabTestIdPrefix="session-cockpit-preview-tab-"
        metrics={props.metrics} bottomInset={0} layout={visibility.mode === 'scroll' ? 'scroll' : 'fit'}
        onSurfacePress={ignorePreviewPress} trailing={<CockpitTabBarActionView metrics={props.metrics}
            testID="session-cockpit-preview-more" label={t('common.more')} icon="dots-three"
            selected={false} onPress={ignorePreviewPress} />} />;
    // Top page tabs draw their strip above the bar, as the Session shows them.
    return stripTabs.length > 0 ? <View style={{ gap: theme.space.s12 }}>
        <PhonePageStripView tabs={stripTabs} activeId={props.activeSurface} onSelect={ignorePreviewPress} testID="session-cockpit-preview-strip" />
        {bar}
    </View> : bar;
}

/** Catalog admission and presentation facts shared by both phone bar presenters. */
export function useSessionCockpitTabDefinitions(props: Pick<SessionCockpitTabBarProps,
    'sessionId' | 'serverId' | 'catalog' | 'openDetailsTabCount'>) {
    const sessionServerId = usePreferredServerIdForSession({ serverId: props.serverId, sessionId: props.sessionId });
    const collaborationTarget = React.useMemo(
        () => normalizeSessionAddress(sessionServerId, props.sessionId),
        [props.sessionId, sessionServerId],
    );
    const session = useSession(props.sessionId, props.serverId);
    const pendingNavigationAddress = React.useMemo(
        () => normalizeSessionAddress(props.serverId ?? session?.serverId, props.sessionId),
        [props.serverId, props.sessionId, session?.serverId],
    );
    const scmStatus = useSessionProjectScmStatus(props.sessionId, props.serverId);
    const gitBadgeMode = useSetting('tabBarGitBadgeMode');
    const openTabsBadgeEnabled = useSetting('tabBarOpenTabsBadgeEnabled');
    // A session whose Agent cannot be named has no brand for this tab. The
    // catalog identity owner already renders that neutrally; substituting the
    // product default would label another Agent's session Claude.
    const agentId = React.useMemo(
        () => (session ? readSessionPresentationAgentId(session) : null) ?? '',
        [session],
    );
    // The session's reachable machine target scopes catalog identity resolution;
    // the same owner the Session header uses, so the capsule and the header
    // cannot resolve one session's Agent through two different machines.
    const reachableMachineTarget = useSessionReachableMachineTarget(props.sessionId, props.serverId);
    const agentCore = isBundledAgentId(agentId) ? getAgentCore(agentId) : null;
    const gitBadge = resolveGitTabBadge(gitBadgeMode, scmStatus);
    const pendingPermissionCount = React.useMemo(
        () => (session ? listPendingPermissionRequests(session).length : 0),
        [session],
    );

    const catalog = props.catalog;
    const tabForEntry = (entry: SessionCockpitMobileCatalogEntry): SessionCockpitTabDefinition => {
        if (entry.owner === 'host') {
            if (entry.id === 'chat') {
                return {
                    id: 'chat',
                    sfSymbol: 'bubble.left',
                    label: agentCore
                        ? t(agentCore.displayNameKey)
                        // No Agent to name yet (unhydrated or unpublished): the tab names its pane.
                        : agentId ? formatAgentLikeIdForDisplay(agentId) : t('phoneNav.rail.chatPane'),
                    icon: {
                        render: ({ size, tintColor }) => (
                            <SessionAgentCatalogIdentityIcon
                                agentId={agentId}
                                machineId={reachableMachineTarget?.machineId ?? null}
                                serverId={props.serverId ?? null}
                                color={tintColor}
                                size={size}
                                testID="session-cockpit-tab-chat-agent-icon"
                            />
                        ),
                    },
                };
            }
            if (entry.id === 'companion') {
                return {
                    id: 'companion',
                    label: t('sessionBoard.companion.title'),
                    icon: 'stack-simple',
                    sfSymbol: sfSymbolForCockpitTabIcon('stack-simple'),
                    // The Companion holds the ask with its answers (lab CAp): an amber
                    // dot says something there is waiting, from the canonical pending flag.
                    ...(pendingPermissionCount > 0
                        ? {
                            badge: { kind: 'attention' as const },
                            accessibilityLabel: t('sessionCompanion.needsYouA11y', { count: pendingPermissionCount }),
                        }
                        : {}),
                };
            }
            return {
                id: 'tabs',
                // "Open files": the Details views open in this session. Not "Tabs" (that word now
                // means the account's open tabs), and not the Companion's layered glyph.
                label: t('phoneNav.bar.openFiles'),
                icon: 'files',
                sfSymbol: sfSymbolForCockpitTabIcon('files'),
                badge: openTabsBadgeEnabled && props.openDetailsTabCount > 0
                    ? { kind: 'count', value: props.openDetailsTabCount }
                    : undefined,
            };
        }
        const tab = entry.tab;
        return {
            id: entry.id,
            label: tab.owner === 'plugin' ? tab.label : t(tab.labelKey),
            icon: tab.icon,
            sfSymbol: sfSymbolForCockpitTabIcon(tab.icon),
            ...(entry.id === 'git' && gitBadge ? { badge: gitBadge } : {}),
        };
    };
    return { catalog, tabForEntry, pendingNavigationAddress, collaborationTarget, agentId, hasBundledAgent: agentCore !== null };
}

/** Read when Customize opens: the desktop arrangement decides which Session tools are also pages. */
function readPaneArrangement(): 'session' | 'editor' {
    return storage.getState().localSettings.paneArrangement === 'editor' ? 'editor' : 'session';
}

export function useSessionCockpitBarPresentation(props: SessionCockpitTabBarProps, native = false) {
    const { catalog, tabForEntry, pendingNavigationAddress, collaborationTarget, agentId, hasBundledAgent } = useSessionCockpitTabDefinitions(props);
    // "Always swipe between sessions" depends on the sideways swipe itself.
    const alwaysSwipeSetting = useSetting('sessionCockpitSwipeAlwaysSessionsEnabled');
    const swipeSetting = useSetting('sessionCockpitSwipeNavigationEnabled');
    const alwaysSwipe = alwaysSwipeSetting === true && swipeSetting !== false;
    const phoneItems = resolveSessionCockpitPhoneItems(catalog).map(entry => {
        const tab = tabForEntry(entry);
        return { ...entry, title: tab.label, icon: typeof tab.icon === 'string' ? tab.icon : 'dots-three' as const,
            ...(entry.id === 'collaboration' && collaborationTarget ? { moreTrailing: <SessionCollaborationRailBadge
                target={collaborationTarget} placement="inline" testID="session-cockpit-more-fact:collaboration" /> } : {}),
        };
    });
    const placement = useDetailPhonePlacement(phoneItems, 'sessionTabBar', 'session');
    const customize = ({ metrics, slotCount }: DetailPhonePreviewMetrics) => {
        const previewTabs = catalog.map(tabForEntry).map(tab => tab.id === 'chat'
            ? { ...tab, icon: { render: ({ size, tintColor }: Readonly<{ size: number; tintColor: string }>) =>
                <AgentIcon agentId={hasBundledAgent ? agentId : null} size={size} color={tintColor} /> } }
            : tab);
        // The one Session Customize, at Phone; the desktop lists resolve from the same mounted inputs.
        const customization = {
            device: 'phone',
            detailInput: props.detailInput ?? { scope: 'session', presentation: 'mobile', terminalTabAvailable: props.terminalTabAvailable, pluginPlacements: props.pluginPlacements },
            arrangement: readPaneArrangement(),
            phoneCatalog: catalog,
            phonePageTabs: true,
            renderPhonePreview: (next: NavigationPlacementPreferences) => <SessionCockpitTabBarPreview
                catalog={catalog} tabs={previewTabs} preferences={next} metrics={metrics}
                activeSurface={props.activeSurface} slotCount={slotCount ?? Number.POSITIVE_INFINITY} alwaysSwipe={alwaysSwipe} />,
        } as const;
        if (props.onCustomize) props.onCustomize(resolveSessionNavigationCustomizerProps(customization));
        else openSessionNavigationCustomizer(customization);
    };
    const presentation = useDetailPhoneBarPresentation({ items: phoneItems, placement, address: 'sessionTabBar', pageKind: 'session',
        activeId: props.activeSurface, select: id => props.onSurfacePress(id as SessionMobileSurface), native,
        overflowBehavior: alwaysSwipe ? 'more' : 'scroll', heldSubtitle: t('phoneNav.bar.heldInMore'), onCustomize: customize });
    // A scrolling bar owns the horizontal axis; the live bar publishes it and the band's swipe steps aside.
    const barScrolls = presentation.layout === 'scroll';
    const visibility = { mode: presentation.mode, visible: presentation.shown, top: placement.topPages,
        held: presentation.held, overflow: placement.placements.overflow };
    return { catalog, tabForEntry, visibility, tabs: presentation.shown.map(tabForEntry), menu: presentation.menu,
        pageTabs: placement.pageTabs, barScrolls, pendingNavigationAddress, openMore: presentation.openMore,
        onTabLongPress: presentation.onTabLongPress };
}

/**
 * Cockpit phones with page tabs at the top (plan T U1): Chat and the pages kept on the bar scroll in one
 * strip under the Session header, while tools and the single More stay in the bottom bar. Same resolved
 * visibility as the bar; nothing is drawn while Chat is the only page.
 */
export const SessionPhonePageStrip = React.memo(function SessionPhonePageStrip(props: Pick<SessionCockpitTabBarProps,
    'sessionId' | 'serverId' | 'catalog' | 'activeSurface' | 'openDetailsTabCount' | 'onSurfacePress'>) {
    const pageTabs = useDetailPageTabsPosition('session');
    return pageTabs === 'top' ? <SessionPhoneTopPageStrip {...props} /> : null;
});

function SessionPhoneTopPageStrip(props: React.ComponentProps<typeof SessionPhonePageStrip>) {
    const { tabForEntry } = useSessionCockpitTabDefinitions(props);
    const { topPages: top } = useDetailPhonePlacement(resolveSessionCockpitPhoneItems(props.catalog), 'sessionTabBar', 'session');
    if (top.length === 0) return null;
    return <PhonePageStripView tabs={top.map(tabForEntry)} activeId={props.activeSurface} onSelect={id => props.onSurfacePress(id as SessionMobileSurface)} />;
}

export const SessionCockpitTabBar = React.memo((props: SessionCockpitTabBarProps) => {
    const { tabs, menu, barScrolls, pendingNavigationAddress, onTabLongPress } = useSessionCockpitBarPresentation(props);
    // The band's actions are built HERE because a tab is the only element in the band a screen
    // reader can focus, and an action only reaches the rotor through the element that owns it.
    // They are the switcher's non-gesture path: step either way, or open it for tapping.
    const switcherBand = useSessionSwitcherBand();
    // Holding this bar docks the Session switcher where that gesture is live, so the hold stays the switcher's there.
    const holdToDock = useSetting('sessionSwitcherHoldToDockEnabled') !== false;
    const switcherInput = useSessionSwitcherInputEnabled();
    const holdOwnedBySwitcher = switcherBand !== null && holdToDock && switcherInput;
    const bandAccessibilityActions = React.useMemo(() => (switcherBand ? [
        { name: SWITCH_SESSION_ACTION, label: t('phoneNav.switcher.switchSessionAction') },
        { name: PREVIOUS_SESSION_ACTION, label: t('workspaceCockpit.previousSession') },
        { name: NEXT_SESSION_ACTION, label: t('workspaceCockpit.nextSession') },
    ] : undefined), [switcherBand]);
    const handleBandAccessibilityAction = React.useCallback((actionName: string) => {
        if (!switcherBand) return;
        if (actionName === SWITCH_SESSION_ACTION) { switcherBand.dock(); return; }
        const direction = actionName === PREVIOUS_SESSION_ACTION ? 'previous' : actionName === NEXT_SESSION_ACTION ? 'next' : null;
        if (direction && !switcherBand.step(direction)) {
            announceAccessibilityMessage(t(direction === 'next' ? 'phoneNav.switcher.noOlderSessions' : 'phoneNav.switcher.noNewerSessions'));
        }
    }, [switcherBand]);
    return (
        <CockpitTabBar
            activeSurface={props.activeSurface}
            barTestId={`session-cockpit-tabbar-${props.sessionId}`}
            tabs={tabs}
            tabTestIdPrefix="session-cockpit-tab-"
            layout={barScrolls ? 'scroll' : 'fit'}
            onSurfacePress={props.onSurfacePress}
            onTabLongPress={holdOwnedBySwitcher ? undefined : onTabLongPress}
            bandAccessibilityActions={bandAccessibilityActions}
            onBandAccessibilityAction={bandAccessibilityActions ? handleBandAccessibilityAction : undefined}
            trailing={<>
                <PendingNavigationPill address={pendingNavigationAddress} presentation="phone" />
                {menu}
            </>}
        />
    );
});
