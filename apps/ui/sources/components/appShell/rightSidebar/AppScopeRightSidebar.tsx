import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import type { PluginSurfaceHostActionExecute } from '@/components/plugins/surfaces/pluginSurfaceActionDispatch';
import {
    PluginSurfacePaneLaunchScope,
    usePluginSurfaceDestinationNavigationBinding,
    usePluginSurfacePaneLaunch,
    usePluginSurfacePaneLaunchScope,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { Text } from '@/components/ui/text/Text';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { PluginReactNativeUnavailable } from '@/components/plugins/reactNative/PluginReactNativeUnavailable';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionPhase } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { RightSidebarIconTabBar } from './RightSidebarIconTabBar';
import {
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
    return inheritedPaneLaunchScope
        ? <AppScopeRightSidebarContent {...props} />
        : (
            <PluginSurfacePaneLaunchScope>
                <AppScopeRightSidebarContent {...props} />
            </PluginSurfacePaneLaunchScope>
        );
}

function AppScopeRightSidebarContent(props: AppScopeRightSidebarProps): React.ReactElement | null {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const scopeState = pane.scopeState;
    const pluginProjection = useAppShellPluginUiProjection();
    const projection = props.pluginUiProjection !== undefined
        ? props.pluginUiProjection
        : pluginProjection.pluginUiProjection;
    const projectionPhase = props.projectionPhase ?? pluginProjection.phase;
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
    }), [placements, projection?.generation]);

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
    const selectTab = React.useCallback((tabId: string) => {
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
        paneLaunchStore.retire();
    }, [pane, paneLaunchStore, tabs]);
    // The app shell owns every app-target navigation registration, including
    // this container's, so a plugin's first `openSurface` can reach the sidebar
    // before its route is entered. This leaf is presentation-only: it renders
    // the selection the app-lifetime owner recorded and never installs a
    // resolver of its own.
    const appTargetBinding = usePluginSurfaceDestinationNavigationBinding();

    // §3.1: this sidebar supplies only the facts it owns. Identity, scope,
    // addressability, the host-ActionSpec front door, the resource snapshot
    // authority and every method's lifetime belong to the bound controller inside
    // `PluginSurfacePlacementHost`; this mount adds only its own destination
    // selector (and, for tests, the canonical executor to inject).
    const binding = React.useMemo<BoundPluginSurfaceBinding>(() => ({
        ...(appTargetBinding ? { openSurface: appTargetBinding.openSurface } : {}),
        ...(props.executeAction ? { executeHostAction: props.executeAction } : {}),
    }), [appTargetBinding, props.executeAction]);

    // The selection owner distinguishes an ordinary empty sidebar from a
    // restored/deep-linked plugin destination whose catalog is still
    // establishing or has now become unavailable. Do not erase that user
    // intent merely because no tab entry is presently renderable.
    if (
        tabs.length === 0
        && tabSelection.kind === 'unavailable'
        && tabSelection.reason === 'right_sidebar_destination_unavailable'
    ) {
        return (
            <View testID={props.testID} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                <Text style={{ color: theme.colors.text.secondary, fontSize: 13, ...Typography.default(), textAlign: 'center' }}>
                    {t('pluginSurfaces.appScopeRightSidebar.empty')}
                </Text>
            </View>
        );
    }

    return (
        <View testID={props.testID} style={{ flex: 1 }}>
            <RightSidebarIconTabBar
                tabs={tabs}
                activeTabId={resolvedActiveTabId ?? ''}
                onSelectTab={selectTab}
                testIDPrefix="app-scope-right-sidebar-tab"
            />
            <View style={{ flex: 1 }}>
                {tabSelection.kind === 'unresolved' ? (
                    <PaneLoadingFallback color={theme.colors.text.secondary} />
                ) : tabSelection.kind === 'unavailable' ? (
                    <PluginReactNativeUnavailable diagnostics={[tabSelection.reason]} />
                ) : activePlacement ? (
                    <PluginSurfaceFocusEligibilityProvider active>
                        <PluginSurfacePlacementHost
                            placement={activePlacement}
                            pluginUiProjection={projection}
                            machineId={machineId}
                            serverId={serverId}
                            platform={platform}
                            projectionInteractionEnabled={interactionEnabled}
                            binding={binding}
                            launchInput={activePaneLaunch?.input}
                            mountInstanceKey={scopeState?.right.selectedDestination?.kind === 'plugin'
                                ? scopeState.right.selectedDestination.instanceKey
                                : undefined}
                        />
                    </PluginSurfaceFocusEligibilityProvider>
                ) : <PluginReactNativeUnavailable diagnostics={['plugin_destination_unavailable']} />}
            </View>
        </View>
    );
}
