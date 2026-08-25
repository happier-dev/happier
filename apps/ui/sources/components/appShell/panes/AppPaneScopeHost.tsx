import * as React from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
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
import { MultiPaneHostWithBottom } from '@/components/ui/panels/MultiPaneHostWithBottom';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { resolvePaneLayout } from '@/components/ui/panels/paneBreakpoints';
import { resolveBottomPaneLayout } from '@/components/ui/panels/resolveBottomPaneLayout';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting, useLocalSettingMutable } from '@/sync/domains/state/storage';
import { useAppPaneContext } from './AppPaneProvider';
import { PANE_SIZING_DEFAULTS, resolveDockedPaneSizing, resolveScaledPaneHeightPx, resolveScaledPaneHeightPxUncapped, resolveScaledPaneWidthPx, resolveScaledPaneWidthPxUncapped } from './layout/paneSizing';
import {
    resolveMultiPaneDeviceType,
    resolvePluginUiRuntimeFormFactor,
} from './layout/resolveMultiPaneDeviceType';
import { applyPaneFocusModeLayoutOverride } from './layout/applyPaneFocusModeLayoutOverride';
import { AppPaneScopeLayoutProvider } from './hooks/useAppPaneScopeLayout';
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
import type {
    PaneBuiltinAdapter,
    PaneDriver,
    PaneRightSidebarAdapter,
    PaneSurfaceScope,
} from './types';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

export type AppPaneScopeHostProps = Readonly<{
    scopeId: string;
    main: React.ReactNode;
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
    detailsPaneBuiltinAdapter?: PaneBuiltinAdapter;
    bottomPaneBuiltinAdapter?: PaneBuiltinAdapter;
    detailsPaneEnabled?: boolean;
}>;

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
        || props.detailsPaneEnabled !== undefined;
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
    const { theme } = useUnistyles();
    const { dispatch, state, getDriver, driverRegistryVersion } = useAppPaneContext();
    const pane = useAppPaneScope(props.scopeId);
    const deviceType = useDeviceType();
    const multiPaneDeviceType = resolveMultiPaneDeviceType({ platform: Platform.OS, deviceType });
    const { width: windowWidthPx, height: windowHeightPx } = useWindowDimensions();
    const [containerWidthPx, setContainerWidthPx] = React.useState<number>(windowWidthPx);
    const [containerHeightPx, setContainerHeightPx] = React.useState<number>(windowHeightPx);
    const [rightDragWidthPx, setRightDragWidthPx] = React.useState<number | null>(null);
    const [detailsDragWidthPx, setDetailsDragWidthPx] = React.useState<number | null>(null);
    const [bottomDragHeightPx, setBottomDragHeightPx] = React.useState<number | null>(null);
    // `useLocalSetting` may return `undefined` transiently during hydration. Treat the setting as
    // enabled unless it has been explicitly disabled to avoid hiding panes on initial load.
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;

    const rightPaneWidthPx = useLocalSetting('rightPaneWidthPx');
    const rightPaneWidthBasisPx = useLocalSetting('rightPaneWidthBasisPx');
    const detailsPaneWidthPx = useLocalSetting('detailsPaneWidthPx');
    const detailsPaneWidthBasisPx = useLocalSetting('detailsPaneWidthBasisPx');
    const bottomPaneHeightPx = useLocalSetting('bottomPaneHeightPx');
    const bottomPaneHeightBasisPx = useLocalSetting('bottomPaneHeightBasisPx');

    const [, setRightPaneWidthPx] = useLocalSettingMutable('rightPaneWidthPx');
    const [, setRightPaneWidthBasisPx] = useLocalSettingMutable('rightPaneWidthBasisPx');
    const [, setDetailsPaneWidthPx] = useLocalSettingMutable('detailsPaneWidthPx');
    const [, setDetailsPaneWidthBasisPx] = useLocalSettingMutable('detailsPaneWidthBasisPx');
    const [, setBottomPaneHeightPx] = useLocalSettingMutable('bottomPaneHeightPx');
    const [, setBottomPaneHeightBasisPx] = useLocalSettingMutable('bottomPaneHeightBasisPx');

    React.useEffect(() => {
        dispatch({ type: 'activateScope', scopeId: props.scopeId });
    }, [dispatch, props.scopeId]);

    const scopeState = state.scopes[props.scopeId];
    const rightOpen = Boolean(scopeState?.right.isOpen);
    const detailsOpen = Boolean(scopeState?.details.isOpen);
    const bottomOpen = Boolean(scopeState?.bottom?.isOpen);
    const driver = React.useMemo(() => getDriver(props.scopeId), [driverRegistryVersion, getDriver, props.scopeId]);
    const paneAdapter = React.useMemo(() => resolvePaneAdapter(driver, props), [
        driver,
        props,
    ]);
    const detailsPaneEnabled = paneAdapter?.detailsPaneEnabled !== false;
    const effectiveDetailsOpen = detailsPaneEnabled ? detailsOpen : false;
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
        selectedDestination: scopeState?.right.selectedDestination,
        runtimeAdmission,
    }), [paneProjection, paneSurfaceScope, runtimeAdmission, scopeState?.right.selectedDestination]);
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
        generation: paneProjection?.generation ?? null,
        interactionEnabled: paneSurfaceScope?.projectionPhase === 'current'
            && paneSurfaceScope.interactionEnabled === true,
    }), [
        paneProjection?.generation,
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
        placements: paneProjection ? Object.values(paneProjection.surfacePlacementsById) : [],
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
                    : <PaneLoadingFallback color={theme.colors.text.secondary} />
                : selectedRightDestinationIsSidebarTab && rightSidebarSelection.kind === 'unavailable'
                    ? <PluginReactNativeUnavailable diagnostics={[rightSidebarSelection.reason]} />
                    : rightSelection.kind === 'available'
            ? renderPluginPane(rightSelection, 'rightPane')
            : rightSelection.kind === 'unresolved'
                ? <PaneLoadingFallback color={theme.colors.text.secondary} />
                    : rightSelection.kind === 'unavailable'
                    ? <PluginReactNativeUnavailable diagnostics={[rightSelection.reason]} />
                    : renderBuiltinPane({
                        adapter: rightPaneBuiltinAdapter,
                        selectedDestination: scopeState?.right.selectedDestination,
                        scopeId: props.scopeId,
                    });
    const detailsPane =
        effectiveDetailsOpen
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
                ? <PaneLoadingFallback color={theme.colors.text.secondary} />
            : bottomSelection.kind === 'unavailable'
                ? <PluginReactNativeUnavailable diagnostics={[bottomSelection.reason]} />
                    : renderBuiltinPane({
                        adapter: bottomPaneBuiltinAdapter,
                        selectedDestination: scopeState?.bottom.selectedDestination,
                        scopeId: props.scopeId,
                    });

    const scaledRightPreferredPx = resolveScaledPaneWidthPxUncapped({
        preferredWidthPx: rightPaneWidthPx,
        basisContainerWidthPx: rightPaneWidthBasisPx,
        containerWidthPx,
        minPx: PANE_SIZING_DEFAULTS.right.minPx,
    });

    const scaledDetailsPreferredPx = resolveScaledPaneWidthPxUncapped({
        preferredWidthPx: detailsPaneWidthPx,
        basisContainerWidthPx: detailsPaneWidthBasisPx,
        containerWidthPx,
        minPx: PANE_SIZING_DEFAULTS.details.minPx,
    });

    const storedEffectiveRightDockWidthPx = resolveScaledPaneWidthPx({
        preferredWidthPx: rightPaneWidthPx,
        basisContainerWidthPx: rightPaneWidthBasisPx,
        containerWidthPx,
        minPx: PANE_SIZING_DEFAULTS.right.minPx,
        maxPx: PANE_SIZING_DEFAULTS.right.maxPx,
    });

    const storedEffectiveDetailsDockWidthPx = resolveScaledPaneWidthPx({
        preferredWidthPx: detailsPaneWidthPx,
        basisContainerWidthPx: detailsPaneWidthBasisPx,
        containerWidthPx,
        minPx: PANE_SIZING_DEFAULTS.details.minPx,
        maxPx: PANE_SIZING_DEFAULTS.details.maxPx,
    });

    const effectiveRightDockWidthPx = rightDragWidthPx ?? storedEffectiveRightDockWidthPx;
    const effectiveDetailsDockWidthPx = detailsDragWidthPx ?? storedEffectiveDetailsDockWidthPx;

    const rightPreferredPxForLayout = rightDragWidthPx ?? scaledRightPreferredPx;
    const detailsPreferredPxForLayout = detailsDragWidthPx ?? scaledDetailsPreferredPx;

    const scaledBottomPreferredPx = resolveScaledPaneHeightPxUncapped({
        preferredHeightPx: bottomPaneHeightPx,
        basisContainerHeightPx: bottomPaneHeightBasisPx,
        containerHeightPx,
        minPx: PANE_SIZING_DEFAULTS.bottom.minPx,
    });

    const bottomPreferredPxForLayout = bottomDragHeightPx ?? scaledBottomPreferredPx;

    const resolvedBottomLayout = resolveBottomPaneLayout({
        containerHeightPx,
        mainMinHeightPx: PANE_SIZING_DEFAULTS.mainMinPx,
        bottomMinHeightPx: PANE_SIZING_DEFAULTS.bottom.minPx,
        preferredHeightPx: bottomPreferredPxForLayout,
    });

    const bottomStoredMaxHeightPxForSizing =
        resolvedBottomLayout.presentation === 'docked'
            ? resolvedBottomLayout.dockMaxHeightPx
            : resolvedBottomLayout.overlayMaxHeightPx;

    const storedEffectiveBottomDockHeightPx = resolveScaledPaneHeightPx({
        preferredHeightPx: bottomPaneHeightPx,
        basisContainerHeightPx: bottomPaneHeightBasisPx,
        containerHeightPx,
        minPx: PANE_SIZING_DEFAULTS.bottom.minPx,
        maxPx: bottomStoredMaxHeightPxForSizing,
    });

    const effectiveBottomDockHeightPx = bottomDragHeightPx ?? storedEffectiveBottomDockHeightPx;
    const bottomResizeMaxHeightPx =
        bottomDragHeightPx != null
            ? resolvedBottomLayout.overlayMaxHeightPx
            : bottomStoredMaxHeightPxForSizing;

    const singlePaneBudgetMaxPx = React.useMemo(() => {
        const mainMinPx = paneFocusModeActive ? 0 : PANE_SIZING_DEFAULTS.mainMinPx;
        const clamp = (value: number, minPx: number, maxPx: number) => Math.min(maxPx, Math.max(minPx, value));
        const rightMax = clamp(containerWidthPx - mainMinPx, PANE_SIZING_DEFAULTS.right.minPx, PANE_SIZING_DEFAULTS.right.maxPx);
        const detailsMax = clamp(containerWidthPx - mainMinPx, PANE_SIZING_DEFAULTS.details.minPx, PANE_SIZING_DEFAULTS.details.maxPx);
        return { rightMax, detailsMax };
    }, [containerWidthPx, paneFocusModeActive]);

    const preferOverlayWhenPreferredDoesNotFit = React.useMemo(() => {
        const rightPrefers =
            rightDragWidthPx != null || storedEffectiveRightDockWidthPx > singlePaneBudgetMaxPx.rightMax + 1;
        const detailsPrefers =
            detailsDragWidthPx != null || storedEffectiveDetailsDockWidthPx > singlePaneBudgetMaxPx.detailsMax + 1;
        return { right: rightPrefers, details: detailsPrefers };
    }, [
        detailsDragWidthPx,
        rightDragWidthPx,
        singlePaneBudgetMaxPx.detailsMax,
        singlePaneBudgetMaxPx.rightMax,
        storedEffectiveDetailsDockWidthPx,
        storedEffectiveRightDockWidthPx,
    ]);

    const resolvedLayoutBase = resolvePaneLayout({
        containerWidthPx,
        deviceType: multiPaneDeviceType,
        multiPaneEnabled,
        rightOpen,
        detailsOpen: effectiveDetailsOpen,
        rightPreferOverlayWhenPreferredDoesNotFit: preferOverlayWhenPreferredDoesNotFit.right,
        detailsPreferOverlayWhenPreferredDoesNotFit: preferOverlayWhenPreferredDoesNotFit.details,
        mainMinPx: paneFocusModeActive ? 0 : PANE_SIZING_DEFAULTS.mainMinPx,
        mainMinPxThreePane: paneFocusModeActive ? 0 : PANE_SIZING_DEFAULTS.mainMinThreePanePx,
        rightMinPx: PANE_SIZING_DEFAULTS.right.minPx,
        detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
        rightPreferredPx: rightPreferredPxForLayout,
        detailsPreferredPx: detailsPreferredPxForLayout,
    });

    const resolvedLayout = applyPaneFocusModeLayoutOverride({
        paneFocusModeActive,
        rightOpen,
        detailsOpen: effectiveDetailsOpen,
        baseLayout: resolvedLayoutBase,
    });

    // NOTE: When both panes are open on narrow widths, `resolvePaneLayout` can return `overlayStack`
    // with `right: 'hidden'` + `details: 'overlay'`. We intentionally keep the right pane "open"
    // in state (but hidden by layout) so that closing details returns the user back to the right
    // pane on small screens.

    const dockSizing = resolveDockedPaneSizing({
        containerWidthPx,
        mainMinPx: paneFocusModeActive ? 0 : PANE_SIZING_DEFAULTS.mainMinPx,
        rightMinPx: PANE_SIZING_DEFAULTS.right.minPx,
        detailsMinPx: PANE_SIZING_DEFAULTS.details.minPx,
        rightWidthPx: effectiveRightDockWidthPx,
        detailsWidthPx: effectiveDetailsDockWidthPx,
        rightGlobalMinPx: PANE_SIZING_DEFAULTS.right.minPx,
        rightGlobalMaxPx: PANE_SIZING_DEFAULTS.right.maxPx,
        detailsGlobalMinPx: PANE_SIZING_DEFAULTS.details.minPx,
        detailsGlobalMaxPx: PANE_SIZING_DEFAULTS.details.maxPx,
        rightDocked: resolvedLayout.right === 'docked' && Boolean(rightPane),
        detailsDocked: resolvedLayout.details === 'docked' && Boolean(detailsPane),
    });

    const mainRegionWidthPx = Math.max(
        0,
        containerWidthPx
            - (resolvedLayout.right === 'docked' && Boolean(rightPane) ? dockSizing.rightWidthPx : 0)
            - (resolvedLayout.details === 'docked' && Boolean(detailsPane) ? dockSizing.detailsWidthPx : 0),
    );

    const baseSizing = React.useMemo(() => {
        const prefersFullScreenOverlay = deviceType === 'phone';
        const clampOverlayWidth = (value: number, minPx: number) => {
            if (prefersFullScreenOverlay) return Math.max(minPx, mainRegionWidthPx);
            if (!Number.isFinite(value)) return minPx;
            return Math.min(mainRegionWidthPx, Math.max(minPx, value));
        };

        const rightWidthPx =
            resolvedLayout.right === 'docked'
                ? dockSizing.rightWidthPx
                : resolvedLayout.right === 'overlay'
                    ? clampOverlayWidth(rightPreferredPxForLayout, PANE_SIZING_DEFAULTS.right.minPx)
                    : 0;

        const detailsWidthPx =
            resolvedLayout.details === 'docked'
                ? dockSizing.detailsWidthPx
                : resolvedLayout.details === 'overlay'
                    ? clampOverlayWidth(detailsPreferredPxForLayout, PANE_SIZING_DEFAULTS.details.minPx)
                    : 0;

        const rightMaxWidthPx =
            resolvedLayout.right === 'docked'
                ? dockSizing.rightMaxWidthPx
                : resolvedLayout.right === 'overlay'
                    ? Math.max(PANE_SIZING_DEFAULTS.right.minPx, mainRegionWidthPx)
                    : PANE_SIZING_DEFAULTS.right.maxPx;

        const detailsMaxWidthPx =
            resolvedLayout.details === 'docked'
                ? dockSizing.detailsMaxWidthPx
                : resolvedLayout.details === 'overlay'
                    ? Math.max(PANE_SIZING_DEFAULTS.details.minPx, mainRegionWidthPx)
                    : PANE_SIZING_DEFAULTS.details.maxPx;

        return { rightWidthPx, detailsWidthPx, rightMaxWidthPx, detailsMaxWidthPx };
    }, [
        deviceType,
        dockSizing.detailsMaxWidthPx,
        dockSizing.detailsWidthPx,
        dockSizing.rightMaxWidthPx,
        dockSizing.rightWidthPx,
        detailsPreferredPxForLayout,
        mainRegionWidthPx,
        resolvedLayout.details,
        resolvedLayout.right,
        rightPreferredPxForLayout,
    ]);

    const focusModeFillPanes = paneFocusModeActive;
    const focusAwareDockSizing = React.useMemo(() => {
        let rightWidthPx = baseSizing.rightWidthPx;
        let detailsWidthPx = baseSizing.detailsWidthPx;
        let rightMaxWidthPx = baseSizing.rightMaxWidthPx;
        let detailsMaxWidthPx = baseSizing.detailsMaxWidthPx;
        let rightMinWidthPx: number | undefined = undefined;
        let detailsMinWidthPx: number | undefined = undefined;

        // While the user is actively dragging a docked pane wider than the main-region budget
        // allows, we want to let them "pull it over the content" and transition to an overlay
        // presentation. If we clamp maxWidth to the docked budget during the drag, the layout
        // resolver never sees an out-of-budget preferred width and cannot switch to overlay.
        const overlayMaxIfRightOverlay = Math.max(
            PANE_SIZING_DEFAULTS.right.minPx,
            containerWidthPx - (resolvedLayout.details === 'docked' ? detailsWidthPx : 0),
        );
        const overlayMaxIfDetailsOverlay = Math.max(
            PANE_SIZING_DEFAULTS.details.minPx,
            containerWidthPx - (resolvedLayout.right === 'docked' ? rightWidthPx : 0),
        );

        // When a pane is presented as an overlay, allow resizing up to the
        // available main-region width (so users can "pull it wider" over the content).
        const overlayMainRegionWidthPx = Math.max(
            0,
            containerWidthPx
                - (resolvedLayout.right === 'docked' ? rightWidthPx : 0)
                - (resolvedLayout.details === 'docked' ? detailsWidthPx : 0),
        );
        if (resolvedLayout.details === 'overlay') {
            detailsMaxWidthPx = Math.max(detailsMaxWidthPx, overlayMainRegionWidthPx);
        }
        if (resolvedLayout.right === 'overlay') {
            rightMaxWidthPx = Math.max(rightMaxWidthPx, overlayMainRegionWidthPx);
        }

        if (resolvedLayout.right === 'docked' && rightDragWidthPx != null) {
            rightMaxWidthPx = Math.max(rightMaxWidthPx, overlayMaxIfRightOverlay);
        }
        if (resolvedLayout.details === 'docked' && detailsDragWidthPx != null) {
            detailsMaxWidthPx = Math.max(detailsMaxWidthPx, overlayMaxIfDetailsOverlay);
        }

        if (focusModeFillPanes) {
            const rightDocked = Boolean(rightPane) && resolvedLayout.right === 'docked';
            const detailsPresent = Boolean(detailsPane) && resolvedLayout.details !== 'hidden';
            const rightPresent = Boolean(rightPane) && resolvedLayout.right !== 'hidden';

            if (detailsPresent) {
                // In focus mode, avoid leaving empty space by stretching the visible details pane
                // to the maximum available width (including widths above the default global max).
                const available = Math.max(
                    PANE_SIZING_DEFAULTS.details.minPx,
                    containerWidthPx - (rightDocked ? rightWidthPx : 0),
                );
                detailsWidthPx = available;
                detailsMaxWidthPx = available;
                detailsMinWidthPx = available;
            } else if (rightPresent) {
                const available = Math.max(PANE_SIZING_DEFAULTS.right.minPx, containerWidthPx);
                rightWidthPx = available;
                rightMaxWidthPx = available;
                rightMinWidthPx = available;
            }
        }

        return {
            rightWidthPx,
            detailsWidthPx,
            rightMaxWidthPx,
            detailsMaxWidthPx,
            rightMinWidthPx,
            detailsMinWidthPx,
        };
    }, [
        baseSizing.detailsMaxWidthPx,
        baseSizing.detailsWidthPx,
        baseSizing.rightMaxWidthPx,
        baseSizing.rightWidthPx,
        containerWidthPx,
        detailsDragWidthPx,
        detailsPane,
        focusModeFillPanes,
        resolvedLayout.details,
        resolvedLayout.right,
        rightDragWidthPx,
        rightPane,
    ]);

    const onCloseRight = React.useCallback(() => {
        dispatch({ type: 'closeRight', scopeId: props.scopeId });
    }, [dispatch, props.scopeId]);

    const onCloseDetails = React.useCallback(() => {
        dispatch({ type: 'closeDetails', scopeId: props.scopeId });
    }, [dispatch, props.scopeId]);

    const onCloseBottom = React.useCallback(() => {
        dispatch({ type: 'closeBottom', scopeId: props.scopeId });
    }, [dispatch, props.scopeId]);

    const onCommitRightDockWidthPx = React.useCallback((nextWidthPx: number) => {
        setRightPaneWidthPx(nextWidthPx);
        setRightPaneWidthBasisPx(containerWidthPx);
    }, [containerWidthPx, setRightPaneWidthBasisPx, setRightPaneWidthPx]);

    const onCommitDetailsDockWidthPx = React.useCallback((nextWidthPx: number) => {
        setDetailsPaneWidthPx(nextWidthPx);
        setDetailsPaneWidthBasisPx(containerWidthPx);
    }, [containerWidthPx, setDetailsPaneWidthBasisPx, setDetailsPaneWidthPx]);

    const onCommitBottomDockHeightPx = React.useCallback((nextHeightPx: number) => {
        setBottomPaneHeightPx(nextHeightPx);
        setBottomPaneHeightBasisPx(containerHeightPx);
    }, [containerHeightPx, setBottomPaneHeightBasisPx, setBottomPaneHeightPx]);

    return (
        <View
            style={{ flex: 1, minHeight: 0, minWidth: 0 }}
            {...pane.overlayFocusReturnCaptureProps}
            onLayout={(event) => {
                const next = Math.round(event?.nativeEvent?.layout?.width ?? 0);
                if (Number.isFinite(next) && next > 0) {
                    setContainerWidthPx((prev) => (Math.abs(prev - next) > 1 ? next : prev));
                }
                const nextHeight = Math.round(event?.nativeEvent?.layout?.height ?? 0);
                if (Number.isFinite(nextHeight) && nextHeight > 0) {
                    setContainerHeightPx((prev) => (Math.abs(prev - nextHeight) > 1 ? nextHeight : prev));
                }
            }}
        >
            <PluginSurfaceDestinationNavigationBindingProvider binding={paneNavigationBinding}>
                <AppPaneScopeLayoutProvider
                    value={{
                        containerWidthPx,
                        containerHeightPx,
                        mainRegionWidthPx,
                        multiPaneEnabled,
                        deviceType: multiPaneDeviceType,
                        layout: resolvedLayout,
                    }}
                >
                    <MultiPaneHostWithBottom
                    main={props.main}
                    hideMain={paneFocusModeActive && (rightOpen || effectiveDetailsOpen)}
                    rightPane={rightPane}
                    detailsPane={detailsPane}
                    layout={resolvedLayout}
                    rightDockWidthPx={focusAwareDockSizing.rightWidthPx}
                    detailsDockWidthPx={focusAwareDockSizing.detailsWidthPx}
                    rightDockMinWidthPx={focusAwareDockSizing.rightMinWidthPx}
                    detailsDockMinWidthPx={focusAwareDockSizing.detailsMinWidthPx}
                    rightDockMaxWidthPx={focusAwareDockSizing.rightMaxWidthPx}
                    detailsDockMaxWidthPx={focusAwareDockSizing.detailsMaxWidthPx}
                    onCloseRight={onCloseRight}
                    onCloseDetails={onCloseDetails}
                    onCommitRightDockWidthPx={onCommitRightDockWidthPx}
                    onCommitDetailsDockWidthPx={onCommitDetailsDockWidthPx}
                    onDragRightDockWidthPx={setRightDragWidthPx}
                    onDragDetailsDockWidthPx={setDetailsDragWidthPx}
                    bottomPane={bottomPane}
                    bottomPresentation={resolvedBottomLayout.presentation}
                    bottomDockHeightPx={effectiveBottomDockHeightPx}
                    bottomDockMinHeightPx={PANE_SIZING_DEFAULTS.bottom.minPx}
                    bottomDockMaxHeightPx={bottomResizeMaxHeightPx}
                    onCloseBottom={onCloseBottom}
                    onCommitBottomDockHeightPx={onCommitBottomDockHeightPx}
                    onDragBottomDockHeightPx={setBottomDragHeightPx}
                    rightOverlayFocusReturnRef={pane.rightOverlayFocusReturnRef}
                    detailsOverlayFocusReturnRef={pane.detailsOverlayFocusReturnRef}
                    bottomOverlayFocusReturnRef={pane.bottomOverlayFocusReturnRef}
                />
                </AppPaneScopeLayoutProvider>
            </PluginSurfaceDestinationNavigationBindingProvider>
        </View>
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
