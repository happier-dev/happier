import * as React from 'react';
import { View } from 'react-native';
import { Modal } from '@/modal';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveDiscussionNavigationCustomizer } from '@/components/workspaceCockpit/discussion/discussionNavigationCustomizer';
import { DiscussionPhonePageStrip } from '@/components/navigation/mobile/chrome/bars/DiscussionCockpitTabBar';

import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { DetailsSplitWorkspace } from '@/components/appShell/panes/details/workspace/DetailsSplitWorkspace';
import { DetailsSurfaceHost } from '@/components/appShell/panes/details/surfaces/DetailsSurfaceHost';
import { createDetailsSurfacePaneCallbacks } from '@/components/appShell/panes/details/surfaces/detailsSurfaceRegistry';
import { createWorkflowDetailsSurfaceRenderers } from '@/components/workflows/run/WorkflowStartDetails';
import { createExecutionRunDetailsSurfaceRenderers } from '@/components/sessions/runs/launcher/executionRunDetailsSurfaceRenderers';
import { DiscussionWorkflowStartDetails } from './DiscussionWorkflowStartDetails';
import { usePaneActionRailRightPaneHiddenByDetails } from '@/components/appShell/panes/PaneActionRailContext';
import type { PaneBuiltinAdapter, PaneRightSidebarAdapter } from '@/components/appShell/panes/types';
import { RightSidebarActionRail } from '@/components/appShell/rightSidebar/RightSidebarActionRail';
import { RightSidebarPaneHeader } from '@/components/appShell/rightSidebar/RightSidebarPaneHeader';
import { toggleRightSidebarTab, usePublishRightSidebarActions } from '@/components/appShell/rightSidebar/rightSidebarActions';
import {
    getRightSidebarTabLabel,
    resolveRightSidebarTabSelection,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { useDetailNavigationItems } from '@/components/appShell/rightSidebar/useDetailNavigationItems';
import type { DetailNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { DiscussionNavigationContext, DISCUSSION_DESKTOP_NAVIGATION_ADDRESS, discussionSurfaceForItem,
    useDiscussionNavigation, selectDiscussionNavigationItem,
} from '@/components/workspaceCockpit/discussion/discussionNavigation';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { SidePaneBodyProvider } from '@/components/ui/lists/listPresentation';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';
import type { DiscussionMobileSurface } from '@/components/workspaceCockpit/discussion/discussionCockpitState';
import { resolveDiscussionMobileSurfaces } from '@/components/workspaceCockpit/discussion/discussionMobileSurfaces';
import {
    createDiscussionRightSidebarPanelsStore,
    DiscussionRightSidebarPanelsContext,
    type DiscussionRightSidebarPanelsStore,
    type DiscussionRightSidebarTabId,
} from './discussionRightSidebarPanels';

/** One pane scope for every Discussion page: which tab is open carries from one Discussion to the next. */
const DISCUSSION_PANE_SCOPE_ID = 'discussion';

const DISCUSSION_WORKFLOW_RENDERERS = createWorkflowDetailsSurfaceRenderers({
    owner: 'workspace', renderStart: input => <DiscussionWorkflowStartDetails input={input} />,
});
const DISCUSSION_DETAILS_SCOPE = Object.freeze({ kind: 'global' as const });

/** The same Details workspace owns Start placement, retained tabs and in-place Run replacement. */
function DiscussionDetailsPane(props: Readonly<{ scopeId: string; serverId?: string | null }>) {
    const pane = useAppPaneScope(props.scopeId);
    const renderers = React.useMemo(() => [
        ...DISCUSSION_WORKFLOW_RENDERERS,
        ...createExecutionRunDetailsSurfaceRenderers({ owner: 'workspace', sessionId: null, serverId: props.serverId }),
    ], [props.serverId]);
    const callbacks = React.useMemo(() => createDetailsSurfacePaneCallbacks({
        openTab: pane.openDetailsTab, closeTab: pane.closeDetailsTab, replaceTab: pane.replaceDetailsTab,
        pinTab: pane.pinDetailsTab, unpinTab: pane.unpinDetailsTab,
    }), [pane.openDetailsTab, pane.closeDetailsTab, pane.replaceDetailsTab, pane.pinDetailsTab, pane.unpinDetailsTab]);
    return <DetailsSplitWorkspace pane={pane} closeLastTab={pane.closeDetails}
        renderTabContent={(tab, presentation) => <DetailsSurfaceHost paneScopeId={props.scopeId} tab={tab} active={presentation.active}
            scope={DISCUSSION_DETAILS_SCOPE} region="details" renderers={renderers} callbacks={callbacks} />} />;
}

function useDiscussionRightSidebarSelection(scopeId: string) {
    const pane = useAppPaneScope(scopeId);
    const navigation = React.useContext(DiscussionNavigationContext)!;
    const tabs = React.useMemo(() => navigation.items.filter(item => item.navigation.kind !== 'page'), [navigation.items]);
    const selection = resolveRightSidebarTabSelection<DiscussionRightSidebarTabId>({
        activeTabId: pane.scopeState?.right.activeTabId,
        selectedDestination: pane.scopeState?.right.selectedDestination ?? null,
        tabs,
        projectionPhase: 'current',
        scope: 'discussion',
    });
    return { pane, tabs, activeTabId: selection.kind === 'available' ? selection.tab.id : null };
}

/** The Discussion's side pane: the open tab's header and its panel, in the pane every page uses. */
function DiscussionRightSidebar(props: Readonly<{ scopeId: string; store: DiscussionRightSidebarPanelsStore }>): React.ReactElement {
    const panels = React.useSyncExternalStore(props.store.subscribe, props.store.read, props.store.read);
    const { pane, tabs, activeTabId } = useDiscussionRightSidebarSelection(props.scopeId);
    return (
        <View testID="discussion-right-sidebar" style={{ flex: 1, minHeight: 0 }}>
            <RightSidebarPaneHeader testID="discussion-right-sidebar.header" tabs={tabs} activeTabId={activeTabId} onClose={pane.closeRight} />
            <SurfaceStateSizeProvider size="pane"><SidePaneBodyProvider>
                <View style={{ flex: 1, minHeight: 0 }}>{activeTabId && panels ? panels[activeTabId] : null}</View>
            </SidePaneBodyProvider></SurfaceStateSizeProvider>
        </View>
    );
}

/** The Discussion's action rail: the same rail and toggle owner a Session's or the App's uses. */
function DiscussionRightSidebarActionRail(props: Readonly<{ scopeId: string }>): React.ReactElement {
    const { pane, tabs, activeTabId } = useDiscussionRightSidebarSelection(props.scopeId);
    const rightPaneHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    const navigation = React.useContext(DiscussionNavigationContext)!;
    const execute = useMountedScopeActionCommand(navigation.scope);
    const side = navigation.readColumn('side');
    const main = navigation.readColumn('main');
    usePublishRightSidebarActions({ tabs: side.tabs ?? [], activeTab: side.activeTab, selectTab: side.selectTab!, items: side.items,
        main: { tabs: main.tabs ?? [], activeTab: main.activeTab, selectTab: main.selectTab!, items: main.items } });
    return <RightSidebarActionRail surfaceId={DISCUSSION_DESKTOP_NAVIGATION_ADDRESS} testID="discussion-right-sidebar-action-rail" testIDPrefix="discussion-right-sidebar-rail"
        onOpenCustomizer={() => {
            const customizer = resolveDiscussionNavigationCustomizer({ items: navigation.items, device: 'desktop' });
            fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ DetailNavigationCustomizer }) => {
                Modal.show({ component: DetailNavigationCustomizer, props: customizer });
            }), { tag: 'DiscussionNavigation.customize' });
        }}
        actions={tabs.map((tab) => ({
            id: tab.id,
            label: getRightSidebarTabLabel(tab),
            icon: tab.icon,
            defaultPlacement: tab.defaultPlacement,
            allowedPlacements: tab.allowedPlacements,
            ...(tab.owner === 'builtin' ? { group: tab.railGroup } : {}),
            active: pane.scopeState?.right.isOpen === true && !rightPaneHiddenByDetails && activeTabId === tab.id,
            disabled: false,
            onPress: () => toggleRightSidebarTab({ ...pane,
                closeRight: () => selectDiscussionNavigationItem(execute, navigation, tab.id, false),
            }, tab.id, activeTabId, id => selectDiscussionNavigationItem(execute, navigation, id), rightPaneHiddenByDetails),
        }))} />;
}

/**
 * One responsive Discussion host. It keeps the thread mounted while desktop pane chrome and phone
 * surfaces change around it; the pane may be drawn outside this subtree, so its adapters carry the
 * panel store themselves.
 */
export function DiscussionPaneHost(props: Readonly<{
    main: React.ReactNode;
    discussionId?: string;
    scope?: ServerAccountScope | null;
    onSurfaceChange?: (surface: DiscussionMobileSurface) => void;
    /** Narrow routes keep this host mounted but do not expose desktop pane destinations. */
    paneEnabled?: boolean;
    /** A cockpit phone can replace the thread with one of the pane-backed surfaces without remounting it. */
    phoneSurface?: DiscussionMobileSurface | null;
    onBackToThread?: () => void;
}>): React.ReactElement {
    const [store] = React.useState(createDiscussionRightSidebarPanelsStore);
    const scopeId = useDestinationPaneScopeId(DISCUSSION_PANE_SCOPE_ID);
    const pane = useAppPaneScope(scopeId);
    const items = useDetailNavigationItems({ scope: 'discussion' });
    const surface = props.phoneSurface ?? 'chat';
    const phone = props.phoneSurface != null;
    const select = React.useCallback((item: DetailNavigationItem) => {
        if (phone) {
            const next = discussionSurfaceForItem(item);
            if (next) props.onSurfaceChange?.(next);
        } else if (item.navigation.kind === 'companion') pane.openRight({ tabId: item.navigation.companion });
    }, [phone, props.onSurfaceChange, pane.openRight]);
    const navigation = useDiscussionNavigation({ discussionId: props.discussionId ?? '', scope: props.scope ?? null,
        phone, items, surface,
        sideVisible: pane.scopeState?.right.isOpen === true, activeCompanionId: pane.scopeState?.right.activeTabId ?? undefined,
        onSelect: select, setVisible: (column, visible) => {
            if (phone) { if ((!visible && column === 'side') || (visible && column === 'main')) props.onSurfaceChange?.('chat'); }
            else if (column === 'side') { if (visible) pane.openRight(); else pane.closeRight(); }
        },
    });
    const adapters = React.useMemo(() => {
        const render = ({ scopeId }: Readonly<{ scopeId: string }>) => <DiscussionNavigationContext.Provider value={navigation}>
            <DiscussionRightSidebar scopeId={scopeId} store={store} /></DiscussionNavigationContext.Provider>;
        const sidebar: PaneRightSidebarAdapter = {
            available: true,
            render,
            renderActionRail: ({ scopeId }) => <DiscussionNavigationContext.Provider value={navigation}>
                <DiscussionRightSidebarActionRail scopeId={scopeId} /></DiscussionNavigationContext.Provider>,
        };
        const pane: PaneBuiltinAdapter = {
            destinationIds: items.filter(item => item.navigation.kind === 'companion').map(item => item.id),
            defaultDestinationId: 'discussionParticipants',
            render,
        };
        const details: PaneBuiltinAdapter = {
            destinationIds: ['details'], defaultDestinationId: 'details',
            render: ({ scopeId }) => <DiscussionDetailsPane scopeId={scopeId} serverId={props.scope?.serverId} />,
        };
        return { sidebar, pane, details };
    }, [store, navigation, items, props.scope?.serverId]);
    return (
        <DiscussionRightSidebarPanelsContext.Provider value={store}>
            <DiscussionNavigationContext.Provider value={navigation}>
            <DiscussionPhoneSurfacePresentation items={items} store={store} surface={surface} onBackToThread={props.onBackToThread}
                main={<AppPaneScopeHost
                    scopeId={scopeId}
                    detailsPaneBuiltinAdapter={adapters.details}
                    {...(props.paneEnabled === false ? {} : {
                        rightSidebarAdapter: adapters.sidebar,
                        rightPaneBuiltinAdapter: adapters.pane,
                    })}
                    main={props.main}
                />} />
            </DiscussionNavigationContext.Provider>
        </DiscussionRightSidebarPanelsContext.Provider>
    );
}

function DiscussionPhoneSurfacePresentation(props: Readonly<{
    items: readonly DetailNavigationItem[];
    store: DiscussionRightSidebarPanelsStore;
    surface: DiscussionMobileSurface;
    onBackToThread?: () => void;
    main: React.ReactNode;
}>): React.ReactElement {
    const entry = props.surface === 'chat'
        ? null
        : resolveDiscussionMobileSurfaces(props.items).find((candidate) => candidate.surface === props.surface) ?? null;
    return <>
        <View style={[{ flex: 1, minHeight: 0 }, entry ? { display: 'none' } : null]}>
            <PluginSurfaceFocusEligibilityProvider active={entry === null}>
                {props.main}
            </PluginSurfaceFocusEligibilityProvider>
        </View>
        {entry ? <DiscussionPhonePanelSurface store={props.store} entry={entry} onBackToThread={props.onBackToThread} /> : null}
    </>;
}

function DiscussionPhonePanelSurface(props: Readonly<{
    store: DiscussionRightSidebarPanelsStore;
    entry: ReturnType<typeof resolveDiscussionMobileSurfaces>[number];
    onBackToThread?: () => void;
}>): React.ReactElement {
    // The surface's own foot (Leave, a pinned row) clears the phone's floating bar, as a Session page's does.
    const barClearance = useFloatingChromeClearance();
    return <View testID={`discussion-phone-surface-${props.entry.surface}`} style={{ flex: 1, minHeight: 0, paddingBottom: barClearance }}>
        <RightSidebarPaneHeader testID="discussion-phone-surface.header" tabs={[props.entry.tab]} activeTabId={props.entry.tab.id} onBack={props.onBackToThread} />
        <DiscussionPhonePageStrip />
        <SurfaceStateSizeProvider size="phone"><SidePaneBodyProvider>
            <DiscussionPhonePanel store={props.store} tabId={props.entry.tabId} />
        </SidePaneBodyProvider></SurfaceStateSizeProvider>
    </View>;
}

function DiscussionPhonePanel(props: Readonly<{
    store: DiscussionRightSidebarPanelsStore;
    tabId: DiscussionRightSidebarTabId;
}>): React.ReactElement | null {
    const panels = React.useSyncExternalStore(props.store.subscribe, props.store.read, props.store.read);
    return panels ? <View style={{ flex: 1, minHeight: 0 }}>{panels[props.tabId]}</View> : null;
}

/**
 * A phone's Discussion: the same panels the rail shows, presented as the surfaces its phone bar switches
 * between (as a Session's phone surfaces are). The thread stays mounted under a surface, so its draft,
 * scroll and the panels it publishes carry over; Back on a surface returns to the thread.
 */
export function DiscussionPhoneSurfaceHost(props: Readonly<{
    surface: DiscussionMobileSurface;
    onBackToThread: () => void;
    main: React.ReactNode;
}>): React.ReactElement {
    const [store] = React.useState(createDiscussionRightSidebarPanelsStore);
    const items = useDetailNavigationItems({ scope: 'discussion' });
    return (
        <DiscussionRightSidebarPanelsContext.Provider value={store}>
            <DiscussionPhoneSurfacePresentation items={items} store={store} surface={props.surface} onBackToThread={props.onBackToThread} main={props.main} />
        </DiscussionRightSidebarPanelsContext.Provider>
    );
}
