import * as React from 'react';
import { View } from 'react-native';
import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
import { useDestinationPageTitle, useDestinationPathname } from '@/components/appShell/workspace/DestinationInstanceHost';
import { PLUGIN_PANELS_ROUTE } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { usePaneActionRail, usePaneActionRailRightPaneHiddenByDetails } from '@/components/appShell/panes/PaneActionRailContext';
import { PaneHeaderSlotScope, PaneHeaderSlotProvider } from '@/components/appShell/panes/paneHeaderSlot';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import type { PluginSurfaceHostActionExecute } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import {
    PluginSurfacePaneLaunchScope,
    usePluginSurfaceDestinationNavigationBinding,
    usePluginSurfacePaneLaunch,
    usePluginSurfacePaneLaunchScope,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceStateSizeProvider } from '@/components/ui/surfaces/surfaceStateSize';
import { SidePaneBodyProvider } from '@/components/ui/lists/listPresentation';
import { PluginReactNativeUnavailable } from '@/components/plugins/reactNative/PluginReactNativeUnavailable';
import { getPreferredLanguage, t } from '@/text';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { isAppShellPluginCatalogPending } from '@/components/appShell/plugins/projectionAvailability';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { AppRightSidebarTabSurface } from './appRightSidebarTabs';
import { RightSidebarIconTabBar } from './RightSidebarIconTabBar';
import { RightSidebarActionRail } from './RightSidebarActionRail';
import { usePresentedDetailNavigationChrome } from './usePresentedDetailNavigation';
import { PluginDetailNavigationRail } from '@/components/plugins/pages/PluginDetailNavigationViews';
import { PluginCompanionOpenedFromContext } from '@/components/plugins/pages/pluginPageNavigationContext';
import { RightSidebarPaneHeader } from './RightSidebarPaneHeader';
import { toggleRightSidebarTab, usePublishRightSidebarActions } from './rightSidebarActions';
import {
    getRightSidebarTabLabel,
    resolveRightSidebarTabSelection,
    resolveRightSidebarTabs,
} from './rightSidebarTabRegistry';
import type {
    RightSidebarPluginTabDefinition,
    RightSidebarTabDefinition,
} from './rightSidebarBuiltinTabs';

/**
 * App-shell consumer for `app.rightSidebarTab` plugin placements (Seam 1).
 *
 * Resolves app-scope plugin tabs through the SAME canonical registry/selector that
 * session/project right sidebars use (`resolveRightSidebarTabs({ scope: 'app' })` +
 * `selectPluginRightSidebarTabPlacements(model, 'app')`) and renders the active tab's
 * surface through the canonical `PluginSurfacePlacementHost`. App-scope plugin tabs
 * mount fail-closed (policy + availability gated) exactly like session/project tabs.
 *
 * There are no app-scope built-in tabs today, so this surface only appears when a
 * first-party plugin contributes an `app.rightSidebarTab` placement.
 */

export type AppScopeRightSidebarProps = Readonly<{
    scopeId: string;
    requestedDestination?: PluginUiDestinationReferenceV1;
    pluginUiProjection?: PluginUiProjectionModel | null;
    projectionPhase?: PluginUiProjectionPhase;
    machineId?: string | null;
    serverId?: string | null;
    platform?: LocalServicePreviewPlatform;
    interactionEnabled?: boolean;
    executeAction?: PluginSurfaceHostActionExecute;
    /** It stands in a page's pane: a header names the open panel and closes the sidebar. */
    closable?: boolean;
    testID?: string;
}>;

function isPluginTab(tab: RightSidebarTabDefinition): tab is RightSidebarPluginTabDefinition {
    return tab.owner === 'plugin';
}

const EMPTY_PLUGIN_DESTINATION: PluginUiDestinationReferenceV1 = Object.freeze({
    pluginId: '',
    localId: '',
});

const AppScopeRightSidebarModelContext = React.createContext<ReturnType<typeof useAppScopeRightSidebarModel> | null>(null);

/** The rail and its later pane receive one delivery from the existing App handoff owner. */
export function AppScopeRightSidebarProvider(props: React.PropsWithChildren<AppScopeRightSidebarProps>): React.ReactElement {
    const inheritedPaneLaunchScope = usePluginSurfacePaneLaunchScope();
    const content = <AppScopeRightSidebarModelProvider {...props} />;
    return inheritedPaneLaunchScope ? content : <PluginSurfacePaneLaunchScope>{content}</PluginSurfacePaneLaunchScope>;
}

function AppScopeRightSidebarModelProvider(props: React.PropsWithChildren<AppScopeRightSidebarProps>): React.ReactElement {
    const model = useAppScopeRightSidebarModel(props);
    return <AppScopeRightSidebarModelContext.Provider value={model}>{props.children}</AppScopeRightSidebarModelContext.Provider>;
}

function useAppScopeRightSidebarModel(props: AppScopeRightSidebarProps) {
    const pane = useAppPaneScope(props.scopeId);
    const runtime = useAppShellPluginUiProjection(value => ({
        pluginUiProjection: value.pluginUiProjection,
        phase: value.phase,
        hasEstablishingMembers: value.hasEstablishingMembers,
        machineId: value.machineId,
        serverId: value.serverId,
        platform: value.platform,
        interactionEnabled: value.interactionEnabled,
    }));
    const projection = props.pluginUiProjection !== undefined ? props.pluginUiProjection : runtime.pluginUiProjection;
    const projectionPhase = props.projectionPhase ?? runtime.phase;
    const hasEstablishingMembers = props.projectionPhase === undefined && runtime.hasEstablishingMembers === true;
    const locale = getPreferredLanguage();
    const localize = usePluginLocalizedTextResolver({ projection, locale });
    const machineId = props.machineId !== undefined ? props.machineId : runtime.machineId;
    const serverId = props.serverId !== undefined ? props.serverId : runtime.serverId;
    const platform = props.platform ?? runtime.platform;
    const interactionEnabled = projectionPhase === 'current' && (props.interactionEnabled ?? runtime.interactionEnabled) === true;
    // The provider boundary borrows the enclosing store or supplies the incumbent standalone scope.
    const { accountLifetime, store } = usePluginSurfacePaneLaunchScope()!;
    const placements = React.useMemo(() => projection ? selectPluginRightSidebarTabPlacements(projection, 'app') : [], [projection]);
    // A page's own companions (`reach: 'pageItems'`) exist as tabs only while that page is presented and names them.
    const presentedPage = usePresentedDetailNavigationChrome();
    const pageCompanionItems = presentedPage?.rootHosted ? presentedPage.companionItems : null;
    const pageCompanions = React.useMemo(() => pageCompanionItems
        ? new Set(pageCompanionItems.flatMap(item => item.navigation.kind === 'page' ? [] : [item.navigation.companion]))
        : null, [pageCompanionItems]);
    const openedFrom = presentedPage?.rootHosted ? presentedPage.openedFrom ?? null : null;
    const tabs = React.useMemo(() => resolveRightSidebarTabs({ scope: 'app', pluginPlacements: placements, localize,
        ...(pageCompanions ? { pageCompanions } : {}) }), [localize, placements, pageCompanions]);
    const selection = React.useMemo(() => resolveRightSidebarTabSelection<string>({
        activeTabId: pane.scopeState?.right.activeTabId,
        selectedDestination: pane.scopeState?.right.selectedDestination ?? null,
        tabs, projectionPhase, hasEstablishingMembers, scope: 'app',
    }), [hasEstablishingMembers, pane.scopeState?.right.activeTabId, pane.scopeState?.right.selectedDestination, projectionPhase, tabs]);
    const activePlacement = selection.kind === 'available' && isPluginTab(selection.tab) ? selection.tab.placement : null;
    const selectedTabId = selection.kind === 'available' ? selection.tab.id : null;
    const activeInstanceKey = pane.scopeState?.right.selectedDestination?.kind === 'plugin'
        ? pane.scopeState.right.selectedDestination.instanceKey : undefined;
    const activePaneLaunch = usePluginSurfacePaneLaunch({
        store, placement: activePlacement, targetKind: 'app', container: 'rightSidebarTab', accountLifetime,
        destination: activePlacement?.binding.destination ?? EMPTY_PLUGIN_DESTINATION,
        ...(activeInstanceKey === undefined ? {} : { instanceKey: activeInstanceKey }),
    });
    const selectTab = useAppRightSidebarTabChooser(props.scopeId, tabs);
    return React.useMemo(() => ({ scopeId: props.scopeId, pane, projection, projectionPhase, hasEstablishingMembers,
        machineId, serverId, platform, interactionEnabled, accountLifetime, tabs, selection, selectedTabId,
        activeInstanceKey, activePaneLaunch, selectTab, openedFrom }), [props.scopeId, pane, projection, projectionPhase,
        hasEstablishingMembers, machineId, serverId, platform, interactionEnabled, accountLifetime, tabs, selection,
        selectedTabId, activeInstanceKey, activePaneLaunch, selectTab, openedFrom]);
}

/**
 * The sidebar is also reachable through the standalone Settings route. Reuse
 * the surrounding AppPane handoff scope when there is one; otherwise establish
 * the same generic scope at that route boundary.
 */
export function AppScopeRightSidebar(props: AppScopeRightSidebarProps): React.ReactElement | null {
    const shared = React.useContext(AppScopeRightSidebarModelContext);
    const content = <PaneHeaderSlotProvider><AppScopeRightSidebarContent {...props} /></PaneHeaderSlotProvider>;
    return shared?.scopeId === props.scopeId ? content : <AppScopeRightSidebarProvider {...props}>{content}</AppScopeRightSidebarProvider>;
}

function AppScopeRightSidebarContent(props: AppScopeRightSidebarProps): React.ReactElement | null {
    const pathname = useDestinationPathname();
    const model = React.useContext(AppScopeRightSidebarModelContext)!;
    const { pane, projection, projectionPhase, hasEstablishingMembers, machineId, serverId, platform, interactionEnabled, tabs, selectTab } = model;
    const hasActionRail = usePaneActionRail();
    const scopeState = pane.scopeState;

    const requestedDestinationKey = props.requestedDestination
        ? `${props.requestedDestination.pluginId}\u0000${props.requestedDestination.localId}`
        : null;
    const appliedRequestedDestinationKeyRef = React.useRef<string | null>(null);
    const pendingRequestedDestination = requestedDestinationKey
        && appliedRequestedDestinationKeyRef.current !== requestedDestinationKey
        ? props.requestedDestination ?? null
        : null;
    const effectiveSelectedDestination = pendingRequestedDestination
        ? { kind: 'plugin' as const, destination: pendingRequestedDestination }
        : scopeState?.right.selectedDestination ?? null;

    const tabSelection = React.useMemo(() => resolveRightSidebarTabSelection<string>({
        activeTabId: scopeState?.right.activeTabId,
        selectedDestination: effectiveSelectedDestination,
        tabs,
        projectionPhase,
        hasEstablishingMembers,
        scope: 'app',
    }), [effectiveSelectedDestination, hasEstablishingMembers, projectionPhase, scopeState?.right.activeTabId, tabs]);
    const resolvedActiveTabId = tabSelection.kind === 'available' ? tabSelection.tab.id : null;
    const activeTab = tabSelection.kind === 'available' ? tabSelection.tab : null;
    useDestinationPageTitle(pathname === PLUGIN_PANELS_ROUTE ? activeTab ? getRightSidebarTabLabel(activeTab) : null : undefined);
    const activePlacement = activeTab && isPluginTab(activeTab) ? activeTab.placement : null;
    const activeInstanceKey = resolvedActiveTabId === model.selectedTabId ? model.activeInstanceKey : undefined;
    const activePaneLaunch = resolvedActiveTabId === model.selectedTabId ? model.activePaneLaunch : null;
    React.useEffect(() => {
        const requested = props.requestedDestination;
        if (!requested || !projection) return;
        const exactTab = tabs.find((candidate) => (
            candidate.owner === 'plugin'
            && candidate.placement.binding.destination.pluginId === requested.pluginId
            && candidate.placement.binding.destination.localId === requested.localId
            && !candidate.disabledReason
        ));
        if (!exactTab) return;
        appliedRequestedDestinationKeyRef.current = requestedDestinationKey;
        const selected = scopeState?.right.selectedDestination;
        if (
            selected?.kind === 'plugin'
            && selected.destination.pluginId === requested.pluginId
            && selected.destination.localId === requested.localId
        ) {
            return;
        }
        pane.selectRightDestination({ kind: 'plugin', destination: requested });
    }, [pane, projection, props.requestedDestination, requestedDestinationKey, scopeState?.right.selectedDestination, tabs]);
    // The app shell owns every app-target navigation registration, including
    // this container's, so a plugin's first `openSurface` can reach the sidebar
    // before its route is entered. This leaf is presentation-only.
    const appTargetBinding = usePluginSurfaceDestinationNavigationBinding();

    const binding = React.useMemo<BoundPluginSurfaceBinding>(() => ({
        ...(appTargetBinding ? { openSurface: appTargetBinding.openSurface } : {}),
        ...(props.executeAction ? { executeHostAction: props.executeAction } : {}),
    }), [appTargetBinding, props.executeAction]);

    if (
        tabs.length === 0
        && (
            tabSelection.kind === 'none'
            || (tabSelection.kind === 'unavailable' && tabSelection.reason === 'right_sidebar_destination_unavailable')
        )
    ) {
        return (
            <SurfaceStateSizeProvider size="pane">
                <SurfaceStateCard testID={props.testID} kind="empty" title={t('pluginSurfaces.appScopeRightSidebar.empty')} />
            </SurfaceStateSizeProvider>
        );
    }

    return (
        <View testID={props.testID} style={{ flex: 1 }}>
            {activeTab ? (
                <RightSidebarPaneHeader
                scopeId={props.scopeId}
                    testID={`${props.testID ?? 'app-scope-right-sidebar'}.header`}
                    tabs={tabs}
                    activeTabId={resolvedActiveTabId}
                    onClose={props.closable ? pane.closeRight : undefined}
                />
            ) : props.closable ? (
                <PaneHeader
                    testID={`${props.testID ?? 'app-scope-right-sidebar'}.header`}
                    title={activeTab ? getRightSidebarTabLabel(activeTab) : t('pluginSurfaces.hostRenderer.descriptorPanel.untitled')}
                    onClose={pane.closeRight}
                />
            ) : null}
            {!hasActionRail ? <RightSidebarIconTabBar
                tabs={tabs}
                activeTabId={resolvedActiveTabId ?? ''}
                onSelectTab={selectTab}
                testIDPrefix="app-scope-right-sidebar-tab"
            /> : null}
            <View style={{ flex: 1 }}>
                <SurfaceStateSizeProvider size="pane"><SidePaneBodyProvider>
                {tabSelection.kind === 'none' ? (
                    <AppScopeRightSidebarNoneState tabs={tabs} onOpen={selectTab} testID={`${props.testID ?? 'app-scope-right-sidebar'}-none`} />
                ) : tabSelection.kind === 'unresolved' ? (
                    <PaneLoadingFallback />
                ) : tabSelection.kind === 'unavailable' ? (
                    <PluginReactNativeUnavailable diagnostics={[tabSelection.reason]} />
                ) : activePlacement ? (
                    <PaneHeaderSlotScope slotKey={activeTab!.id}>
                        {/* A page companion reads the page that opened it; any other App tab has no opener. */}
                        <PluginCompanionOpenedFromContext.Provider value={activePlacement.display.reach === 'pageItems' ? model.openedFrom : null}>
                        <AppRightSidebarTabSurface
                            placement={activePlacement}
                            facts={{ pluginUiProjection: projection, machineId, serverId, platform, interactionEnabled }}
                            binding={binding}
                            launchInput={activePaneLaunch?.input}
                            mountInstanceKey={activeInstanceKey}
                        />
                        </PluginCompanionOpenedFromContext.Provider>
                    </PaneHeaderSlotScope>
                ) : <PluginReactNativeUnavailable diagnostics={['plugin_destination_unavailable']} />}
                </SidePaneBodyProvider></SurfaceStateSizeProvider>
            </View>
        </View>
    );
}

/**
 * Opened with panels but none chosen (the side toggle on a page that never picked one): the pane is never
 * blank (lab EM1, "the column is never blank"). It invites the first available panel in rail order;
 * the rail beside it lists the rest.
 */
function AppScopeRightSidebarNoneState(props: Readonly<{
    tabs: readonly RightSidebarTabDefinition[];
    onOpen: (tabId: string) => void;
    testID: string;
}>): React.ReactElement {
    const first = props.tabs.find((tab) => !tab.disabledReason) ?? null;
    return (
        <SurfaceStateCard
            testID={props.testID}
            kind="empty"
            iconName="sidebar-right-open"
            title={t('pluginSurfaces.appScopeRightSidebar.noneTitle')}
            reason={t('pluginSurfaces.appScopeRightSidebar.noneReason')}
            action={first ? {
                label: t('pluginSurfaces.appScopeRightSidebar.noneOpen', { name: getRightSidebarTabLabel(first) }),
                onPress: () => props.onOpen(first.id),
                testID: `${props.testID}-open`,
            } : undefined}
        />
    );
}

/** The strip and desktop rail share the same deliberate-selection and input-retirement owner. */
function useAppRightSidebarTabChooser(scopeId: string, tabs: readonly RightSidebarTabDefinition[]): (tabId: string) => void {
    const pane = useAppPaneScope(scopeId);
    const paneLaunchStore = usePluginSurfacePaneLaunchScope()?.store;
    return React.useCallback((tabId: string) => {
        const tab = tabs.find((candidate) => candidate.id === tabId) ?? null;
        if (!tab || tab.disabledReason) {
            return;
        }
        if (isPluginTab(tab)) {
            pane.selectRightDestination({
                kind: 'plugin',
                destination: tab.placement.binding.destination,
            });
        } else {
            pane.openRight({ tabId });
        }
        // A deliberate tab choice has no launch argument. The generic store is
        // one bounded handoff slot, so no prior plugin input can revive when a
        // user returns to this selection later.
        paneLaunchStore?.retire();
    }, [pane, paneLaunchStore, tabs]);
}

/** The desktop App rail uses the same catalog and persisted selection as its fallback strip. */
export function AppScopeRightSidebarActionRail(props: Readonly<{ scopeId: string }>): React.ReactElement {
    const shared = React.useContext(AppScopeRightSidebarModelContext);
    const content = <AppScopeRightSidebarActionRailContent />;
    return shared?.scopeId === props.scopeId ? content : <AppScopeRightSidebarProvider {...props}>{content}</AppScopeRightSidebarProvider>;
}

function AppScopeRightSidebarActionRailContent(): React.ReactElement {
    const model = React.useContext(AppScopeRightSidebarModelContext)!;
    const detail = usePresentedDetailNavigationChrome();
    const rightPaneHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    return detail?.rootHosted && detail.companionItems.length > 0
        ? <PluginDetailNavigationRail model={detail} pane={model.pane} rightPaneHiddenByDetails={rightPaneHiddenByDetails} />
        : <AppScopeWorkspaceRail />;
}

function AppScopeWorkspaceRail(): React.ReactElement {
    const model = React.useContext(AppScopeRightSidebarModelContext)!;
    const { pane, tabs, selection, selectTab } = model;
    const actionsPending = isAppShellPluginCatalogPending({ phase: model.projectionPhase, hasEstablishingMembers: model.hasEstablishingMembers });
    const rightPaneHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    usePublishRightSidebarActions({
        tabs: tabs.filter(tab => !tab.disabledReason).map(tab => tab.id),
        activeTab: selection.kind === 'available' ? selection.tab.id : undefined,
        selectTab,
    });
    return <RightSidebarActionRail surfaceId="workspaceRail" testID="app-scope-right-sidebar-action-rail" testIDPrefix="app-scope-right-sidebar-rail" actionsPending={actionsPending} actions={tabs.map((tab) => ({
        id: tab.id,
        label: getRightSidebarTabLabel(tab),
        icon: tab.icon,
        defaultPlacement: tab.defaultPlacement,
        allowedPlacements: tab.allowedPlacements,
        pluginCount: tab.owner === 'plugin' ? { tab, runtime: {
            pluginUiProjection: model.projection,
            machineId: model.machineId, serverId: model.serverId,
            accountLifetime: model.accountLifetime,
            interactionEnabled: model.interactionEnabled,
        }, mountInstanceKey: model.selectedTabId === tab.id ? model.activeInstanceKey : undefined,
        launchInput: model.selectedTabId === tab.id ? model.activePaneLaunch?.input : undefined } : undefined,
        active: pane.scopeState?.right.isOpen === true && !rightPaneHiddenByDetails && selection.kind === 'available' && selection.tab.id === tab.id,
        disabled: Boolean(tab.disabledReason),
        onPress: () => toggleRightSidebarTab(pane, tab.id, selection.kind === 'available' ? selection.tab.id : null, selectTab, rightPaneHiddenByDetails),
    }))} />;
}
