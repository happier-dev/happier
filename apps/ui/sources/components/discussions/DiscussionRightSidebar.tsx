import * as React from 'react';
import { View } from 'react-native';

import { AppPaneScopeHost } from '@/components/appShell/panes/AppPaneScopeHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { usePaneActionRailRightPaneHiddenByDetails } from '@/components/appShell/panes/PaneActionRailContext';
import type { PaneBuiltinAdapter, PaneRightSidebarAdapter } from '@/components/appShell/panes/types';
import { RightSidebarActionRail } from '@/components/appShell/rightSidebar/RightSidebarActionRail';
import { RightSidebarPaneHeader } from '@/components/appShell/rightSidebar/RightSidebarPaneHeader';
import { toggleRightSidebarTab, usePublishRightSidebarActions } from '@/components/appShell/rightSidebar/rightSidebarActions';
import {
    getRightSidebarTabLabel,
    resolveRightSidebarTabSelection,
    resolveRightSidebarTabs,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
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

const DISCUSSION_RIGHT_SIDEBAR_TAB_IDS: readonly DiscussionRightSidebarTabId[] = Object.freeze([
    'discussionParticipants', 'discussionAgents', 'discussionDetails',
]);

function useDiscussionRightSidebarSelection(scopeId: string) {
    const pane = useAppPaneScope(scopeId);
    const tabs = React.useMemo(() => resolveRightSidebarTabs({ scope: 'discussion' }).filter(item => item.navigation.kind !== 'page'), []);
    const selection = resolveRightSidebarTabSelection<DiscussionRightSidebarTabId>({
        activeTabId: pane.scopeState?.right.activeTabId,
        selectedDestination: pane.scopeState?.right.selectedDestination ?? null,
        tabs,
        projectionPhase: 'current',
        scope: 'discussion',
    });
    const selectTab = React.useCallback((tabId: string) => pane.openRight({ tabId }), [pane]);
    return { pane, tabs, activeTabId: selection.kind === 'available' ? selection.tab.id : null, selectTab };
}

/** The Discussion's side pane: the open tab's header and its panel, in the pane every page uses. */
function DiscussionRightSidebar(props: Readonly<{ scopeId: string; store: DiscussionRightSidebarPanelsStore }>): React.ReactElement {
    const panels = React.useSyncExternalStore(props.store.subscribe, props.store.read, props.store.read);
    const { pane, tabs, activeTabId } = useDiscussionRightSidebarSelection(props.scopeId);
    return (
        <View testID="discussion-right-sidebar" style={{ flex: 1, minHeight: 0 }}>
            <RightSidebarPaneHeader testID="discussion-right-sidebar.header" tabs={tabs} activeTabId={activeTabId} onClose={pane.closeRight} />
            <SurfaceStateSizeProvider size="pane">
                <View style={{ flex: 1, minHeight: 0 }}>{activeTabId && panels ? panels[activeTabId] : null}</View>
            </SurfaceStateSizeProvider>
        </View>
    );
}

/** The Discussion's action rail: the same rail and toggle owner a Session's or the App's uses. */
function DiscussionRightSidebarActionRail(props: Readonly<{ scopeId: string }>): React.ReactElement {
    const { pane, tabs, activeTabId, selectTab } = useDiscussionRightSidebarSelection(props.scopeId);
    const rightPaneHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    usePublishRightSidebarActions({ tabs: tabs.map(tab => tab.id), activeTab: activeTabId ?? undefined, selectTab });
    return <RightSidebarActionRail surfaceId="workspaceRail" testID="discussion-right-sidebar-action-rail" testIDPrefix="discussion-right-sidebar-rail"
        actions={tabs.map((tab) => ({
            id: tab.id,
            label: getRightSidebarTabLabel(tab),
            icon: tab.icon,
            defaultPlacement: tab.defaultPlacement,
            allowedPlacements: tab.allowedPlacements,
            ...(tab.owner === 'builtin' ? { group: tab.railGroup } : {}),
            active: pane.scopeState?.right.isOpen === true && !rightPaneHiddenByDetails && activeTabId === tab.id,
            disabled: false,
            onPress: () => toggleRightSidebarTab(pane, tab.id, activeTabId, selectTab, rightPaneHiddenByDetails),
        }))} />;
}

/**
 * One responsive Discussion host. It keeps the thread mounted while desktop pane chrome and phone
 * surfaces change around it; the pane may be drawn outside this subtree, so its adapters carry the
 * panel store themselves.
 */
export function DiscussionPaneHost(props: Readonly<{
    main: React.ReactNode;
    /** Narrow routes keep this host mounted but do not expose desktop pane destinations. */
    paneEnabled?: boolean;
    /** A cockpit phone can replace the thread with one of the pane-backed surfaces without remounting it. */
    phoneSurface?: DiscussionMobileSurface | null;
    onBackToThread?: () => void;
}>): React.ReactElement {
    const [store] = React.useState(createDiscussionRightSidebarPanelsStore);
    const adapters = React.useMemo(() => {
        const render = ({ scopeId }: Readonly<{ scopeId: string }>) => <DiscussionRightSidebar scopeId={scopeId} store={store} />;
        const sidebar: PaneRightSidebarAdapter = {
            available: true,
            render,
            renderActionRail: ({ scopeId }) => <DiscussionRightSidebarActionRail scopeId={scopeId} />,
        };
        const pane: PaneBuiltinAdapter = {
            destinationIds: DISCUSSION_RIGHT_SIDEBAR_TAB_IDS,
            defaultDestinationId: 'discussionParticipants',
            render,
        };
        return { sidebar, pane };
    }, [store]);
    return (
        <DiscussionRightSidebarPanelsContext.Provider value={store}>
            <DiscussionPhoneSurfacePresentation store={store} surface={props.phoneSurface ?? 'chat'} onBackToThread={props.onBackToThread}
                main={<AppPaneScopeHost
                    scopeId={DISCUSSION_PANE_SCOPE_ID}
                    {...(props.paneEnabled === false ? {} : {
                        rightSidebarAdapter: adapters.sidebar,
                        rightPaneBuiltinAdapter: adapters.pane,
                    })}
                    main={props.main}
                />} />
        </DiscussionRightSidebarPanelsContext.Provider>
    );
}

function DiscussionPhoneSurfacePresentation(props: Readonly<{
    store: DiscussionRightSidebarPanelsStore;
    surface: DiscussionMobileSurface;
    onBackToThread?: () => void;
    main: React.ReactNode;
}>): React.ReactElement {
    const entry = props.surface === 'chat'
        ? null
        : resolveDiscussionMobileSurfaces().find((candidate) => candidate.surface === props.surface) ?? null;
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
        <SurfaceStateSizeProvider size="phone">
            <DiscussionPhonePanel store={props.store} tabId={props.entry.tabId} />
        </SurfaceStateSizeProvider>
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
    return (
        <DiscussionRightSidebarPanelsContext.Provider value={store}>
            <DiscussionPhoneSurfacePresentation store={store} surface={props.surface} onBackToThread={props.onBackToThread} main={props.main} />
        </DiscussionRightSidebarPanelsContext.Provider>
    );
}
