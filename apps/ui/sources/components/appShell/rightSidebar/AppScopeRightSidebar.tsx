import * as React from 'react';
import { View } from 'react-native';
import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PaneHeader } from '@/components/appShell/panes/PaneHeader';
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
import { PluginReactNativeUnavailable } from '@/components/plugins/reactNative/PluginReactNativeUnavailable';
import { getPreferredLanguage, t } from '@/text';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { AppRightSidebarTabSurface, useAppRightSidebarTabs } from './appRightSidebarTabs';
import { RightSidebarIconTabBar } from './RightSidebarIconTabBar';
import { RightSidebarActionRail } from './RightSidebarActionRail';
import { RightSidebarPaneHeader } from './RightSidebarPaneHeader';
import { toggleRightSidebarTab } from './rightSidebarActions';
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

/**
 * The sidebar is also reachable through the standalone Settings route. Reuse
 * the surrounding AppPane handoff scope when there is one; otherwise establish
 * the same generic scope at that route boundary.
 */
export function AppScopeRightSidebar(props: AppScopeRightSidebarProps): React.ReactElement | null {
    const inheritedPaneLaunchScope = usePluginSurfacePaneLaunchScope();
    const content = <PaneHeaderSlotProvider><AppScopeRightSidebarContent {...props} /></PaneHeaderSlotProvider>;
    return inheritedPaneLaunchScope
        ? content
        : (
            <PluginSurfacePaneLaunchScope>
                {content}
            </PluginSurfacePaneLaunchScope>
        );
}

function AppScopeRightSidebarContent(props: AppScopeRightSidebarProps): React.ReactElement | null {
    const pane = useAppPaneScope(props.scopeId);
    const hasActionRail = usePaneActionRail();
    const scopeState = pane.scopeState;
    const pluginProjection = useAppShellPluginUiProjection();
    const projection = props.pluginUiProjection !== undefined
        ? props.pluginUiProjection
        : pluginProjection.pluginUiProjection;
    const projectionPhase = props.projectionPhase ?? pluginProjection.phase;
    const pluginLocale = getPreferredLanguage();
    const localizePluginText = React.useMemo(
        () => createPluginLocalizedTextResolver({ projection, locale: pluginLocale }),
        [pluginLocale, projection],
    );
    const machineId = props.machineId !== undefined ? props.machineId : pluginProjection.machineId;
    const serverId = props.serverId !== undefined ? props.serverId : pluginProjection.serverId;
    const platform = props.platform ?? pluginProjection.platform;
    const interactionEnabled = projectionPhase === 'current'
        && (props.interactionEnabled ?? pluginProjection.interactionEnabled) === true;
    const paneLaunchScope = usePluginSurfacePaneLaunchScope();
    if (!paneLaunchScope) {
        // The outer route boundary always supplies the generic scope. Refuse to
        // manufacture an unbound input store if this invariant is broken.
        return null;
    }
    const { accountLifetime, store: paneLaunchStore } = paneLaunchScope;

    const placements = React.useMemo(() => (
        projection ? selectPluginRightSidebarTabPlacements(projection, 'app') : []
    ), [projection]);

    const tabs = React.useMemo(() => resolveRightSidebarTabs({
        scope: 'app',
        pluginPlacements: placements,
        projectionGeneration: projection?.generation ?? null,
        localize: localizePluginText,
    }), [localizePluginText, placements, projection?.generation]);

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
        scope: 'app',
    }), [effectiveSelectedDestination, projectionPhase, scopeState?.right.activeTabId, tabs]);
    const resolvedActiveTabId = tabSelection.kind === 'available' ? tabSelection.tab.id : null;
    const activeTab = tabSelection.kind === 'available' ? tabSelection.tab : null;
    const activePlacement = activeTab && isPluginTab(activeTab) ? activeTab.placement : null;
    const activeInstanceKey = scopeState?.right.selectedDestination?.kind === 'plugin'
        ? scopeState.right.selectedDestination.instanceKey
        : undefined;
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
    const activePaneLaunch = usePluginSurfacePaneLaunch({
        store: paneLaunchStore,
        placement: activePlacement,
        targetKind: 'app',
        container: 'rightSidebarTab',
        accountLifetime,
        destination: activePlacement?.binding.destination ?? EMPTY_PLUGIN_DESTINATION,
        ...(activeInstanceKey === undefined ? {} : { instanceKey: activeInstanceKey }),
    });
    const selectTab = useAppRightSidebarTabChooser(props.scopeId, tabs);
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
                <SurfaceStateSizeProvider size="pane">
                {tabSelection.kind === 'none' ? (
                    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flex: 1 }} />
                ) : tabSelection.kind === 'unresolved' ? (
                    <PaneLoadingFallback />
                ) : tabSelection.kind === 'unavailable' ? (
                    <PluginReactNativeUnavailable diagnostics={[tabSelection.reason]} />
                ) : activePlacement ? (
                    <PaneHeaderSlotScope slotKey={activeTab!.id}>
                        <AppRightSidebarTabSurface
                            placement={activePlacement}
                            facts={{ pluginUiProjection: projection, machineId, serverId, platform, interactionEnabled }}
                            binding={binding}
                            launchInput={activePaneLaunch?.input}
                            mountInstanceKey={activeInstanceKey}
                        />
                    </PaneHeaderSlotScope>
                ) : <PluginReactNativeUnavailable diagnostics={['plugin_destination_unavailable']} />}
                </SurfaceStateSizeProvider>
            </View>
        </View>
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
    const pane = useAppPaneScope(props.scopeId);
    const rightPaneHiddenByDetails = usePaneActionRailRightPaneHiddenByDetails();
    const tabs = useAppRightSidebarTabs();
    const { phase } = useAppShellPluginUiProjection();
    const selection = resolveRightSidebarTabSelection<string>({
        activeTabId: pane.scopeState?.right.activeTabId,
        selectedDestination: pane.scopeState?.right.selectedDestination ?? null,
        tabs,
        projectionPhase: phase,
        scope: 'app',
    });
    const selectTab = useAppRightSidebarTabChooser(props.scopeId, tabs);
    return <RightSidebarActionRail surfaceId="workspaceRail" testID="app-scope-right-sidebar-action-rail" testIDPrefix="app-scope-right-sidebar-rail" actions={tabs.map((tab) => ({
        id: tab.id,
        label: getRightSidebarTabLabel(tab),
        icon: tab.icon,
        active: pane.scopeState?.right.isOpen === true && !rightPaneHiddenByDetails && selection.kind === 'available' && selection.tab.id === tab.id,
        disabled: Boolean(tab.disabledReason),
        onPress: () => toggleRightSidebarTab(pane, tab.id, selection.kind === 'available' ? selection.tab.id : null, selectTab, rightPaneHiddenByDetails),
    }))} />;
}
