import * as React from 'react';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import {
    createPluginSurfacePaneLaunchStore,
    PluginSurfaceDestinationNavigationBindingProvider,
    stagePluginSurfacePaneLaunch,
    usePluginSurfaceDestinationNavigationBinding,
    usePluginSurfaceDestinationNavigationBindingForScope,
    useRegisterPluginSurfaceDestinationNavigationOwner,
    usePluginSurfacePaneLaunch,
    type PluginSurfaceDestinationNavigationBinding,
    type PluginSurfacePaneLaunchStore,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { PluginReactNativeUnavailable } from '@/components/plugins/reactNative/PluginReactNativeUnavailable';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { useDeviceType } from '@/utils/platform/responsive';
import { useDestinationFocus } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useAppPaneContext } from './AppPaneProvider';
import { PaneColumnsHost } from './PaneColumnsHost';
import { resolvePluginUiRuntimeFormFactor } from './layout/resolveMultiPaneDeviceType';
import {
    resolveSelectedPaneDestination,
    type PaneDestinationRuntimeAdmission,
} from './model/resolveSelectedPaneDestination';
import type { SelectedPaneDestinationV1 } from './model/selectedPaneDestination';
import {
    PluginDetailsDestinationLaunchScope,
    usePluginDetailsDestinationNavigationOwners,
} from './details/surfaces/pluginDetailsDestination';
import { useAppPaneScope } from './hooks/useAppPaneScope';
import { useAppPaneActionRailVisible } from './hooks/useAppPaneActionRailVisible';
import type {
    PaneBuiltinAdapter,
    PaneDriver,
    PaneRightSidebarAdapter,
    PaneSurfaceScope,
} from './types';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { selectPluginDestinationSurfacePlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/**
 * A destination-owned details pane (the route owns its selection, e.g. the Plugins page's open
 * plugin): it takes the details column, and the scope's persisted details workspace is not used.
 */
export type AppPaneDestinationDetails = Readonly<{
    pane: React.ReactNode;
    /** The pane asks to close (its close button, Escape, a tap on the overlay scrim). */
    onClose: () => void;
}>;

export type AppPaneScopeHostProps = Readonly<{
    scopeId: string;
    main: React.ReactNode;
    /** The main content's own minimum width before a pane becomes an overlay. */
    mainMinWidthPx?: number;
    /**
     * Installs one scope-local context boundary around main and every pane after
     * measured layout is available. It owns no pane state and must return the
     * supplied host exactly once.
     */
    wrapScopeContent?: (content: React.ReactElement) => React.ReactNode;
    /**
     * Shares this host's exact, current pane destination owner with an
     * incumbent Session/Project semantic launcher. The launcher receives no
     * pane state or private handoff store and cannot become another owner.
     */
    onPluginSurfaceOpenChange?: (handler: PluginSurfaceOpenHandler | undefined) => void;
    /**
     * A semantic sibling (for example the Session header) may register its
     * incumbent container callback with this same target binding. It never
     * receives pane persistence or launch-input custody.
     */
    onPluginSurfaceNavigationBindingChange?: (
        binding: PluginSurfaceDestinationNavigationBinding | undefined,
    ) => void;
    /** Direct scope adapters are for hosts without a registered PaneDriver. */
    surfaceScope?: PaneSurfaceScope;
    rightPaneBuiltinAdapter?: PaneBuiltinAdapter;
    rightSidebarAdapter?: PaneRightSidebarAdapter;
    bottomPaneBuiltinAdapter?: PaneBuiltinAdapter;
}> & (
    | Readonly<{
        detailsPaneBuiltinAdapter?: PaneBuiltinAdapter;
        detailsPaneEnabled?: boolean;
        destinationDetails?: undefined;
    }>
    | Readonly<{
        /** Present (even `null`, closed): the destination owns the details pane. */
        destinationDetails: AppPaneDestinationDetails | null;
        detailsPaneBuiltinAdapter?: never;
        detailsPaneEnabled?: never;
    }>
);

type PaneSelectionResolution = ReturnType<typeof resolveSelectedPaneDestination>;
type AvailablePaneSelection = Extract<PaneSelectionResolution, Readonly<{ kind: 'available' }>>;

type ResolvedPaneAdapter = Readonly<{
    surfaceScope?: PaneSurfaceScope;
    rightPaneBuiltinAdapter?: PaneBuiltinAdapter;
    rightSidebarAdapter?: PaneRightSidebarAdapter;
    detailsPaneBuiltinAdapter?: PaneBuiltinAdapter;
    bottomPaneBuiltinAdapter?: PaneBuiltinAdapter;
    detailsPaneEnabled?: boolean;
}>;

function hasDirectPaneAdapter(props: AppPaneScopeHostProps): boolean {
    return props.surfaceScope !== undefined
        || props.rightPaneBuiltinAdapter !== undefined
        || props.rightSidebarAdapter !== undefined
        || props.detailsPaneBuiltinAdapter !== undefined
        || props.bottomPaneBuiltinAdapter !== undefined
        || props.detailsPaneEnabled !== undefined
        || props.destinationDetails !== undefined;
}

/**
 * AppPane resolves exactly one adapter source. Direct props are normalized
 * once for direct-adapter hosts; a registered driver is likewise
 * normalized once. Supplying both is an authority collision and therefore
 * leaves the scope unresolved rather than granting either source precedence.
 */
function resolvePaneAdapter(
    driver: PaneDriver | null,
    props: AppPaneScopeHostProps,
): ResolvedPaneAdapter | null {
    const hasDirectAdapter = hasDirectPaneAdapter(props);
    if (driver && hasDirectAdapter) return null;

    if (driver) {
        return {
            ...(driver.surfaceScope === undefined ? {} : { surfaceScope: driver.surfaceScope }),
            ...(driver.rightPaneBuiltinAdapter === undefined
                ? {}
                : { rightPaneBuiltinAdapter: driver.rightPaneBuiltinAdapter }),
            ...(driver.rightSidebarAdapter === undefined
                ? {}
                : { rightSidebarAdapter: driver.rightSidebarAdapter }),
            ...(driver.detailsPaneBuiltinAdapter === undefined
                ? {}
                : { detailsPaneBuiltinAdapter: driver.detailsPaneBuiltinAdapter }),
            ...(driver.bottomPaneBuiltinAdapter === undefined
                ? {}
                : { bottomPaneBuiltinAdapter: driver.bottomPaneBuiltinAdapter }),
        };
    }

    if (!hasDirectAdapter) return null;
    return {
        ...(props.surfaceScope === undefined ? {} : { surfaceScope: props.surfaceScope }),
        ...(props.rightPaneBuiltinAdapter === undefined
            ? {}
            : { rightPaneBuiltinAdapter: props.rightPaneBuiltinAdapter }),
        ...(props.rightSidebarAdapter === undefined
            ? {}
            : { rightSidebarAdapter: props.rightSidebarAdapter }),
        ...(props.detailsPaneBuiltinAdapter === undefined
            ? {}
            : { detailsPaneBuiltinAdapter: props.detailsPaneBuiltinAdapter }),
        ...(props.bottomPaneBuiltinAdapter === undefined
            ? {}
            : { bottomPaneBuiltinAdapter: props.bottomPaneBuiltinAdapter }),
        ...(props.detailsPaneEnabled === undefined ? {} : { detailsPaneEnabled: props.detailsPaneEnabled }),
    };
}

function renderBuiltinPane(input: Readonly<{
    adapter: PaneBuiltinAdapter | null;
    selectedDestination: SelectedPaneDestinationV1 | null | undefined;
    scopeId: string;
}>): React.ReactNode | null {
    if (input.selectedDestination?.kind === 'plugin') return null;
    const destinationId = input.selectedDestination?.kind === 'builtin'
        ? input.selectedDestination.id
        : input.adapter?.defaultDestinationId;
    if (!destinationId) return null;
    if (!input.adapter || !input.adapter.destinationIds.includes(destinationId)) return null;
    return input.adapter.render({ scopeId: input.scopeId, destinationId });
}

function resolveScopedPaneDestination(input: Readonly<{
    container: 'rightPane' | 'rightSidebarTab' | 'bottomPane';
    scope: PaneSurfaceScope | null;
    projection: PluginUiProjectionModel | null | undefined;
    appProjection?: PluginUiProjectionModel | null;
    selectedDestination: SelectedPaneDestinationV1 | null | undefined;
    runtimeAdmission: PaneDestinationRuntimeAdmission;
}>): PaneSelectionResolution {
    if (!input.scope) {
        return input.selectedDestination?.kind === 'plugin'
            ? { kind: 'unresolved' }
            : { kind: 'builtin' };
    }
    return resolveSelectedPaneDestination({
        container: input.container,
        targetKind: input.scope.targetKind,
        projection: input.projection,
        ...(input.appProjection === undefined ? {} : { appProjection: input.appProjection }),
        projectionPhase: input.scope.projectionPhase,
        selectedDestination: input.selectedDestination,
        runtimeAdmission: input.runtimeAdmission,
    });
}

/**
 * A direct AppPane mount consumes the common handoff slot selected by the
 * resolver. AppPane continues to own selection and persistence; this leaf only
 * delivers the ephemeral input to that one mounted binding.
 */
function PluginAppPaneSurface(props: Readonly<{
    selection: AvailablePaneSelection;
    container: 'rightPane' | 'bottomPane';
    paneProjection: PluginUiProjectionModel | null;
    paneSurfaceScope: PaneSurfaceScope;
    binding: BoundPluginSurfaceBinding | undefined;
    store: PluginSurfacePaneLaunchStore;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    scopedLaunchFacts: PluginSurfaceScopedLaunchFacts;
    runtimeAdmission: PaneDestinationRuntimeAdmission;
}>): React.ReactElement {
    const launch = usePluginSurfacePaneLaunch({
        store: props.store,
        placement: props.selection.placement,
        targetKind: props.paneSurfaceScope.targetKind,
        container: props.container,
        accountLifetime: props.accountLifetime,
        scopedLaunchFacts: props.scopedLaunchFacts,
        destination: props.selection.placement.binding.destination,
        ...(props.selection.instanceKey === undefined ? {} : { instanceKey: props.selection.instanceKey }),
    });
    return (
        <PluginSurfaceFocusEligibilityProvider active>
            <PluginSurfacePlacementHost
                placement={props.selection.placement}
                pluginUiProjection={props.paneProjection}
                machineId={props.paneSurfaceScope.machineId}
                serverId={props.paneSurfaceScope.serverId}
                sessionId={props.paneSurfaceScope.targetKind === 'session' ? props.paneSurfaceScope.sessionId : undefined}
                agentId={props.paneSurfaceScope.targetKind === 'session' ? props.paneSurfaceScope.agentId : undefined}
                projectId={props.paneSurfaceScope.targetKind === 'project' ? props.paneSurfaceScope.projectId : undefined}
                platform={props.paneSurfaceScope.platform}
                formFactor={props.runtimeAdmission.formFactor}
                projectionInteractionEnabled={props.paneSurfaceScope.projectionPhase === 'current'
                    && props.paneSurfaceScope.interactionEnabled === true}
                binding={props.binding}
                launchInput={launch?.input}
                mountInstanceKey={props.selection.instanceKey}
            />
        </PluginSurfaceFocusEligibilityProvider>
    );
}

const AppPaneScopeHostContent = React.memo((props: AppPaneScopeHostProps) => {
    const enclosingNavigationBinding = usePluginSurfaceDestinationNavigationBinding();
    const { dispatch, state, getDriver, driverRegistryVersion } = useAppPaneContext();
    const pane = useAppPaneScope(props.scopeId);
    const deviceType = useDeviceType();
    const appProjection = useAppShellPluginUiProjection().pluginUiProjection;
    const screenFocused = useDestinationFocus();

    // The page on screen owns the active scope; a page left behind (still mounted under the one on
    // screen) releases it, so "the current page's right sidebar" always names the page the user sees.
    React.useEffect(() => {
        if (!screenFocused) return;
        dispatch({ type: 'activateScope', scopeId: props.scopeId });
        return () => dispatch({ type: 'releaseScope', scopeId: props.scopeId });
    }, [dispatch, props.scopeId, screenFocused]);

    const scopeState = state.scopes[props.scopeId];
    const rightOpen = Boolean(scopeState?.right.isOpen);
    const detailsOpen = Boolean(scopeState?.details.isOpen);
    const bottomOpen = Boolean(scopeState?.bottom?.isOpen);
    const driver = React.useMemo(() => getDriver(props.scopeId), [driverRegistryVersion, getDriver, props.scopeId]);
    const paneAdapter = React.useMemo(() => resolvePaneAdapter(driver, props), [
        driver,
        props,
    ]);
    const showActionRail = useAppPaneActionRailVisible(props.scopeId, paneAdapter?.rightSidebarAdapter ?? null);
    const detailsPaneEnabled = paneAdapter?.detailsPaneEnabled !== false;
    const destinationDetails = props.destinationDetails;
    const destinationOwnsDetails = destinationDetails !== undefined;
    const effectiveDetailsOpen = destinationOwnsDetails
        ? destinationDetails !== null
        : detailsPaneEnabled ? detailsOpen : false;
    const paneFocusModeActive =
        state.focusMode?.scopeId === props.scopeId
        && state.activeScopeId === props.scopeId
        && (rightOpen || effectiveDetailsOpen);

    const paneSurfaceScope = React.useMemo<PaneSurfaceScope | null>(() => {
        // `scopeId` is opaque. A missing registered/direct scope adapter is an
        // unresolved target, never an inferred App target.
        return paneAdapter?.surfaceScope ?? null;
    }, [
        paneAdapter?.surfaceScope,
    ]);
    const paneProjection = paneSurfaceScope?.pluginUiProjection ?? null;
    const runtimeAdmission = React.useMemo<PaneDestinationRuntimeAdmission>(() => Object.freeze({
        // A direct scope already owns the host platform handed to its placement
        // mount. Keep the same fact here so pre-selection admission cannot
        // disagree with the terminal guard.
        platform: paneSurfaceScope?.platform ?? 'web',
        formFactor: resolvePluginUiRuntimeFormFactor({ deviceType }),
    }), [deviceType, paneSurfaceScope?.platform]);
    const rightSelection = React.useMemo(() => resolveScopedPaneDestination({
        container: 'rightPane',
        scope: paneSurfaceScope,
        projection: paneProjection,
        selectedDestination: scopeState?.right.selectedDestination,
        runtimeAdmission,
    }), [paneProjection, paneSurfaceScope, runtimeAdmission, scopeState?.right.selectedDestination]);
    const rightSidebarSelection = React.useMemo(() => resolveScopedPaneDestination({
        container: 'rightSidebarTab',
        scope: paneSurfaceScope,
        projection: paneProjection,
        appProjection,
        selectedDestination: scopeState?.right.selectedDestination,
        runtimeAdmission,
    }), [appProjection, paneProjection, paneSurfaceScope, runtimeAdmission, scopeState?.right.selectedDestination]);
    const bottomSelection = React.useMemo(() => resolveScopedPaneDestination({
        container: 'bottomPane',
        scope: paneSurfaceScope,
        projection: paneProjection,
        selectedDestination: scopeState?.bottom.selectedDestination,
        runtimeAdmission,
    }), [paneProjection, paneSurfaceScope, runtimeAdmission, scopeState?.bottom.selectedDestination]);

    const rightPaneBuiltinAdapter = paneAdapter?.rightPaneBuiltinAdapter ?? null;
    const rightSidebarAdapter = paneAdapter?.rightSidebarAdapter ?? null;
    const detailsPaneBuiltinAdapter = paneAdapter?.detailsPaneBuiltinAdapter ?? null;
    const bottomPaneBuiltinAdapter = paneAdapter?.bottomPaneBuiltinAdapter ?? null;

    // The shared Account lifetime is the only retirement source for the
    // AppPane-private handoff. It carries no pane state and is never persisted.
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const [paneLaunchStore] = React.useState(createPluginSurfacePaneLaunchStore);
    const scopedLaunchFacts = React.useMemo<PluginSurfaceScopedLaunchFacts>(() => Object.freeze({
        serverId: paneSurfaceScope?.serverId ?? null,
        machineId: paneSurfaceScope?.machineId ?? null,
        interactionEnabled: paneSurfaceScope?.projectionPhase === 'current'
            && paneSurfaceScope.interactionEnabled === true,
    }), [
        paneSurfaceScope?.interactionEnabled,
        paneSurfaceScope?.projectionPhase,
        paneSurfaceScope?.machineId,
        paneSurfaceScope?.serverId,
    ]);
    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(() => {
            paneLaunchStore.retire();
        });
        return () => retirement?.dispose();
    }, [accountLifetime, paneLaunchStore]);
    React.useEffect(() => () => { paneLaunchStore.retire(); }, [paneLaunchStore]);

    const openPaneDestination = React.useCallback((resolution: Parameters<typeof stagePluginSurfacePaneLaunch>[0]['resolution']) => {
        if (!stagePluginSurfacePaneLaunch({ store: paneLaunchStore, resolution })) {
            return { ok: false as const, code: 'unavailable' as const, reason: 'plugin_surface_open_origin_unavailable' };
        }
        const destination = {
            kind: 'plugin' as const,
            destination: resolution.placement.binding.destination,
            ...(resolution.request.instanceKey === undefined ? {} : { instanceKey: resolution.request.instanceKey }),
        };
        if (resolution.placement.binding.container === 'rightPane') {
            dispatch({ type: 'selectRightDestination', scopeId: props.scopeId, destination });
            return { ok: true as const };
        }
        if (resolution.placement.binding.container === 'bottomPane') {
            dispatch({ type: 'selectBottomDestination', scopeId: props.scopeId, destination });
            return { ok: true as const };
        }
        // The resolver's handler map below never names another container. Do
        // not turn this defensive branch into a hidden pane/sidebar fallback.
        paneLaunchStore.retire();
        return { ok: false as const, code: 'unavailable' as const, reason: 'plugin_surface_open_destination_owner_unavailable' };
    }, [dispatch, paneLaunchStore, props.scopeId]);
    const detailsDestinationMount = React.useMemo(() => {
        if (paneSurfaceScope?.targetKind === 'session') {
            return {
                sessionId: paneSurfaceScope.sessionId,
                agentId: paneSurfaceScope.agentId,
                machineId: paneSurfaceScope.machineId,
                serverId: paneSurfaceScope.serverId,
                platform: paneSurfaceScope.platform,
                formFactor: runtimeAdmission.formFactor,
                projectionPhase: paneSurfaceScope.projectionPhase,
                projectionInteractionEnabled: paneSurfaceScope.projectionPhase === 'current'
                    && paneSurfaceScope.interactionEnabled === true,
            };
        }
        if (paneSurfaceScope?.targetKind === 'project') {
            return {
                projectId: paneSurfaceScope.projectId,
                machineId: paneSurfaceScope.machineId,
                serverId: paneSurfaceScope.serverId,
                platform: paneSurfaceScope.platform,
                formFactor: runtimeAdmission.formFactor,
                projectionPhase: paneSurfaceScope.projectionPhase,
                projectionInteractionEnabled: paneSurfaceScope.projectionPhase === 'current'
                    && paneSurfaceScope.interactionEnabled === true,
            };
        }
        return {
            machineId: null,
            serverId: null,
            projectionPhase: 'unavailable' as const,
            projectionInteractionEnabled: false,
        };
    }, [paneSurfaceScope, runtimeAdmission.formFactor]);
    const detailsDestinationOwners = usePluginDetailsDestinationNavigationOwners({
        targetKind: paneSurfaceScope?.targetKind ?? 'session',
        projection: paneProjection,
        mount: detailsDestinationMount,
        openTab: pane.openDetailsTab,
        openOverlay: pane.openDetailsOverlay,
    });
    const targetNavigationBinding = usePluginSurfaceDestinationNavigationBindingForScope({
        placements: paneProjection ? selectPluginDestinationSurfacePlacements(paneProjection) : [],
        targetKind: paneSurfaceScope?.targetKind ?? 'session',
        accountLifetime,
        scopedLaunchFacts,
        runtimeAdmission,
        enclosingOpenSurface: enclosingNavigationBinding?.openSurface,
    });
    const paneNavigationBinding = paneSurfaceScope ? targetNavigationBinding : null;
    const rightPaneOwner = React.useMemo(() => paneSurfaceScope
        ? { container: 'rightPane' as const, handler: openPaneDestination }
        : null,
    [openPaneDestination, paneSurfaceScope]);
    const bottomPaneOwner = React.useMemo(() => paneSurfaceScope
        ? { container: 'bottomPane' as const, handler: openPaneDestination }
        : null,
    [openPaneDestination, paneSurfaceScope]);
    const detailsTabOwner = React.useMemo(() => (
        paneSurfaceScope && detailsDestinationOwners
            ? { container: 'detailsTab' as const, handler: detailsDestinationOwners.detailsTab }
            : null
    ), [detailsDestinationOwners, paneSurfaceScope]);
    const detailsPaneOwner = React.useMemo(() => (
        paneSurfaceScope && detailsDestinationOwners
            ? { container: 'detailsPane' as const, handler: detailsDestinationOwners.detailsPane }
            : null
    ), [detailsDestinationOwners, paneSurfaceScope]);
    useRegisterPluginSurfaceDestinationNavigationOwner(rightPaneOwner, paneNavigationBinding);
    useRegisterPluginSurfaceDestinationNavigationOwner(bottomPaneOwner, paneNavigationBinding);
    useRegisterPluginSurfaceDestinationNavigationOwner(detailsTabOwner, paneNavigationBinding);
    useRegisterPluginSurfaceDestinationNavigationOwner(detailsPaneOwner, paneNavigationBinding);
    const openSurface = paneNavigationBinding?.openSurface;
    const paneSurfaceTargetKind = paneSurfaceScope?.targetKind ?? null;
    const paneSurfaceTargetId = paneSurfaceScope?.targetKind === 'session'
        ? paneSurfaceScope.sessionId
        : paneSurfaceScope?.targetKind === 'project'
            ? paneSurfaceScope.projectId
            : null;
    const publishedOpenSurface = React.useMemo(() => {
        if (!openSurface) return undefined;
        // A semantic launcher can retain this callback after React begins
        // replacing the direct scope. Fence that escaped reference at the
        // host lifecycle boundary: it delegates to the same resolver while
        // live and has no selection/persistence authority of its own.
        let isLive = false;
        return {
            handler: (async (request) => {
                if (!isLive) {
                    return {
                        ok: false as const,
                        code: 'unavailable' as const,
                        reason: 'plugin_surface_open_destination_owner_unavailable',
                    };
                }
                return openSurface(request);
            }) satisfies PluginSurfaceOpenHandler,
            publish: () => { isLive = true; },
            retire: () => { isLive = false; },
        };
    // Callback identity is a subscription boundary too: a replaced semantic
    // launcher must not keep a handler that becomes live again for a new
    // target or Account while the AppPane scope itself remains mounted.
    }, [
        accountLifetime,
        openSurface,
        paneSurfaceTargetId,
        paneSurfaceTargetKind,
        props.onPluginSurfaceOpenChange,
    ]);
    React.useEffect(() => {
        publishedOpenSurface?.publish();
        props.onPluginSurfaceOpenChange?.(publishedOpenSurface?.handler);
        return () => {
            publishedOpenSurface?.retire();
            props.onPluginSurfaceOpenChange?.(undefined);
        };
    }, [props.onPluginSurfaceOpenChange, publishedOpenSurface]);
    React.useEffect(() => {
        props.onPluginSurfaceNavigationBindingChange?.(paneNavigationBinding ?? undefined);
        return () => props.onPluginSurfaceNavigationBindingChange?.(undefined);
    }, [paneNavigationBinding, props.onPluginSurfaceNavigationBindingChange]);
    const pluginBinding = React.useMemo<BoundPluginSurfaceBinding | undefined>(
        () => openSurface ? { openSurface } : undefined,
        [openSurface],
    );
    const renderPluginPane = React.useCallback((
        selection: AvailablePaneSelection,
        container: 'rightPane' | 'bottomPane',
    ) => paneSurfaceScope ? (
        <PluginAppPaneSurface
            selection={selection}
            container={container}
            paneProjection={paneProjection}
            paneSurfaceScope={paneSurfaceScope}
            binding={pluginBinding}
            store={paneLaunchStore}
            accountLifetime={accountLifetime}
            scopedLaunchFacts={scopedLaunchFacts}
            runtimeAdmission={runtimeAdmission}
        />
    ) : null, [
        accountLifetime,
        paneLaunchStore,
        paneProjection,
        paneSurfaceScope,
        pluginBinding,
        runtimeAdmission,
        scopedLaunchFacts,
    ]);

    // `MultiPaneHost` uses pane node presence as the logical "open" signal. Keep the
    // nodes null when closed so hidden layouts don't accidentally mount expensive panes.
    // A selection is durable identity, not a right-pane fallback hint. The
    // right-sidebar resolver can name one of three useful facts: this is an
    // admitted tab, its projection has not settled yet, or its own destination
    // is unavailable. Only a known binding for another container proceeds to
    // the direct right-pane resolver; otherwise retain the selected tab's own
    // tombstone reason rather than recasting it as a container mismatch.
    const selectedRightDestinationIsSidebarTab = scopeState?.right.selectedDestination?.kind === 'plugin'
        && (
            rightSidebarSelection.kind === 'available'
            || rightSidebarSelection.kind === 'unresolved'
            || (
                rightSidebarSelection.kind === 'unavailable'
                && rightSidebarSelection.reason !== 'pane_destination_container_unavailable'
            )
        );
    const rightPane = !rightOpen
        ? null
        : selectedRightDestinationIsSidebarTab && rightSidebarSelection.kind === 'available'
            ? rightSidebarAdapter?.render({ scopeId: props.scopeId }) ?? null
            : selectedRightDestinationIsSidebarTab && rightSidebarSelection.kind === 'unresolved'
                ? rightSidebarAdapter
                    ? rightSidebarAdapter.render({ scopeId: props.scopeId })
                    : <PaneLoadingFallback />
                : selectedRightDestinationIsSidebarTab && rightSidebarSelection.kind === 'unavailable'
                    ? <PluginReactNativeUnavailable diagnostics={[rightSidebarSelection.reason]} />
                    : rightSelection.kind === 'available'
            ? renderPluginPane(rightSelection, 'rightPane')
            : rightSelection.kind === 'unresolved'
                ? <PaneLoadingFallback />
                    : rightSelection.kind === 'unavailable'
                    ? <PluginReactNativeUnavailable diagnostics={[rightSelection.reason]} />
                    : renderBuiltinPane({
                        adapter: rightPaneBuiltinAdapter,
                        selectedDestination: scopeState?.right.selectedDestination,
                        scopeId: props.scopeId,
                    });
    const detailsPane = destinationOwnsDetails
        ? destinationDetails?.pane ?? null
        : effectiveDetailsOpen
            ? renderBuiltinPane({
                adapter: detailsPaneBuiltinAdapter,
                selectedDestination: null,
                scopeId: props.scopeId,
            })
            : null;
    const bottomPane = !bottomOpen
        ? null
        : bottomSelection.kind === 'available'
            ? renderPluginPane(bottomSelection, 'bottomPane')
            : bottomSelection.kind === 'unresolved'
                ? <PaneLoadingFallback />
            : bottomSelection.kind === 'unavailable'
                ? <PluginReactNativeUnavailable diagnostics={[bottomSelection.reason]} />
                    : renderBuiltinPane({
                        adapter: bottomPaneBuiltinAdapter,
                        selectedDestination: scopeState?.bottom.selectedDestination,
                        scopeId: props.scopeId,
                    });

    const onCloseRight = React.useCallback(() => {
        dispatch({ type: 'closeRight', scopeId: props.scopeId });
    }, [dispatch, props.scopeId]);

    const closeDestinationDetails = destinationDetails?.onClose;
    const onCloseDetails = React.useCallback(() => {
        if (destinationOwnsDetails) {
            closeDestinationDetails?.();
            return;
        }
        dispatch({ type: 'closeDetails', scopeId: props.scopeId });
    }, [closeDestinationDetails, destinationOwnsDetails, dispatch, props.scopeId]);

    const onCloseBottom = React.useCallback(() => {
        dispatch({ type: 'closeBottom', scopeId: props.scopeId });
    }, [dispatch, props.scopeId]);

    const wrapScopeContent = props.wrapScopeContent;
    const wrapContent = React.useCallback((content: React.ReactElement) => (
        // A scope without a target of its own (the App's pages) keeps the enclosing app-target binding.
        <PluginSurfaceDestinationNavigationBindingProvider binding={paneNavigationBinding ?? enclosingNavigationBinding}>
            {wrapScopeContent ? wrapScopeContent(content) : content}
        </PluginSurfaceDestinationNavigationBindingProvider>
    ), [enclosingNavigationBinding, paneNavigationBinding, wrapScopeContent]);

    return (
        <PaneColumnsHost
            main={props.main}
            mainMinWidthPx={props.mainMinWidthPx}
            rightPane={rightPane}
            detailsPane={detailsPane}
            bottomPane={bottomPane}
            rightOpen={rightOpen}
            detailsOpen={effectiveDetailsOpen}
            destinationOwnsDetails={destinationOwnsDetails}
            detailsOpenedFrom={scopeState?.details.openedFrom ?? null}
            bottomOpen={bottomOpen}
            paneFocusModeActive={paneFocusModeActive}
            actionRail={showActionRail ? rightSidebarAdapter?.renderActionRail?.({ scopeId: props.scopeId }) ?? null : null}
            onCloseRight={onCloseRight}
            onCloseDetails={onCloseDetails}
            onCloseBottom={onCloseBottom}
            rightOverlayFocusReturnRef={pane.rightOverlayFocusReturnRef}
            detailsOverlayFocusReturnRef={pane.detailsOverlayFocusReturnRef}
            bottomOverlayFocusReturnRef={pane.bottomOverlayFocusReturnRef}
            rootProps={pane.overlayFocusReturnCaptureProps}
            wrapContent={wrapContent}
        />
    );
});

/**
 * One Details launch scope spans both the AppPane destination opener and the
 * mounted Details workspace. The wrapper is lifecycle-only; `AppPaneScopeHost`
 * remains the sole selection/layout owner.
 */
export const AppPaneScopeHost = React.memo((props: AppPaneScopeHostProps) => (
    <PluginDetailsDestinationLaunchScope>
        <AppPaneScopeHostContent {...props} />
    </PluginDetailsDestinationLaunchScope>
));
