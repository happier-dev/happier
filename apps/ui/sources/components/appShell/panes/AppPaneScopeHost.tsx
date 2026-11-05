import * as React from 'react';
import { View } from 'react-native';
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
import { resolvePluginSurfaceDestinationLabel } from '@/components/plugins/surfaces/pluginSurfaceDestinations';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import type { PluginSurfaceScopedLaunchFacts } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { PluginReactNativeUnavailable } from '@/components/plugins/reactNative/PluginReactNativeUnavailable';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { useDeviceType } from '@/utils/platform/responsive';
import { useDestinationFocus } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useAppPaneContext } from './AppPaneProvider';
import { AppPaneContext } from './AppPaneContext';
import { PaneColumnsHost } from './PaneColumnsHost';
import { usePaneArrangement } from './arrangement/usePaneArrangement';
import { useOptionalAppPaneScopeLayout } from './hooks/useAppPaneScopeLayout';
import { usePresentedDetailNavigationChrome, type DetailNavigationMainColumnControls } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import { PaneMainColumnContext, type PaneMainColumnDescriptor, type PaneMainColumnState } from './mainColumn/usePaneMainColumn';
import { RightSidebarActionsContext, type RightSidebarActions } from '@/components/appShell/rightSidebar/rightSidebarActions';
import { RightPanePlacementReporterContext, type RightPanePresentation } from './rightPanePlacement';
import { registerShellColumnActionOwner, notifyShellColumnActionOwnersChanged, type ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { useKeyboardShortcutHandlers } from '@/keyboard/KeyboardShortcutProvider';
import type { ResolvedPaneLayout } from '@/components/ui/panels/paneBreakpoints';
import { resolvePluginUiRuntimeFormFactor } from './layout/resolveMultiPaneDeviceType';
import {
    resolveSelectedPaneDestination,
    type PaneDestinationRuntimeAdmission,
} from './model/resolveSelectedPaneDestination';
import { isSelectedPaneSlotVisible, readSelectedPaneDestinationSlot, selectedPaneDestinationTabKey, type SelectedPaneDestinationV1 } from './model/selectedPaneDestination';
import { useOpenPaneDestinationWindow, usePaneDestinationWindowActions } from './useOpenPaneDestinationWindow';
import { PaneHeader } from './PaneHeader';
import { PaneHeaderActions } from './PaneHeaderActions';
import { PluginDetailsPaneOverlay } from './details/surfaces/PluginDetailsPaneOverlay';
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
    selectedPaneTabKey?: string;
    /** A creation default, never an instruction to reopen an existing scope. */
    main: React.ReactNode;
    /** Hosts without a named main column never offer the hide control. */
    mainColumn?: PaneMainColumnDescriptor;
    arrangement?: 'honour' | 'session';
    /** SHELL UI supplies the permanent editor's empty page. */
    emptyEditorPane?: React.ReactNode;
    /** Ancestor Session presentation consumes this same measured host control, including its drawer. */
    onMainColumnControlsChange?: (controls: PaneMainColumnState | null) => void;
    /** The main content's own minimum width before a pane becomes an overlay. */
    mainMinWidthPx?: number;
    detailsPreferredWidthPx?: number;
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
    /** Direct scope adapters are published by this host as its PaneDriver. */
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

/** Measured host controls: no second pane state or layout resolver. */
function AppPaneScopeControls(props: Readonly<{
    scopeId: string;
    focused: boolean;
    descriptor?: PaneMainColumnDescriptor;
    rightOpen: boolean;
    detailsOpen: boolean;
    sideAvailable: boolean;
    arrangementHonoured: boolean;
    onControlsChange?: (controls: PaneMainColumnState | null) => void;
    setHidden: (hidden: boolean) => void;
    setSideVisible: (visible: boolean) => void;
    sideActions: React.MutableRefObject<RightSidebarActions | null>;
    children: React.ReactNode;
}>) {
    const layout = useOptionalAppPaneScopeLayout();
    const detailNavigation = usePresentedDetailNavigationChrome();
    const folded = layout?.layout.main === 'overlay';
    const hidden = layout?.mainHidden === true || (folded && !layout?.mainDrawerOpen);
    const canHide = props.descriptor !== undefined && layout != null
        && layout.layout.kind !== 'single' && (props.rightOpen || layout.effectiveDetailsOpen || props.detailsOpen);
    const labels = React.useMemo(() => ({
        hideLabel: props.descriptor?.hideLabel ?? '',
        showLabel: props.descriptor?.showLabel ?? '',
    }), [props.descriptor?.hideLabel, props.descriptor?.showLabel]);
    // An intent can open Details and hide main in one batch, before canHide has rendered again.
    // Availability controls entry points; the measured host alone resolves effective visibility.
    const setHidden = props.setHidden;
    const toggle = React.useCallback(() => setHidden(!hidden), [hidden, setHidden]);
    const value = React.useMemo<PaneMainColumnState | null>(() => props.descriptor === undefined ? null : ({
        hidden, canHide, folded, labels, identity: props.descriptor.identity, setHidden, toggle,
    }), [canHide, folded, hidden, labels, props.descriptor?.identity, setHidden, toggle]);
    const current = React.useRef({ props, layout, hidden, canHide, labels, detailNavigation });
    current.current = { props, layout, hidden, canHide, labels, detailNavigation };
    const readPhysicalMain = React.useCallback((): DetailNavigationMainColumnControls => {
        const { props, layout, hidden, canHide, labels } = current.current;
        return {
            present: true, visible: props.descriptor === undefined || !hidden,
            available: canHide || props.sideActions.current?.main !== undefined,
            label: props.descriptor === undefined ? undefined : hidden ? labels.showLabel : labels.hideLabel,
            arrangementAvailable: props.arrangementHonoured && layout?.multiPaneEnabled === true && layout.deviceType !== 'phone',
            setVisible: visible => props.setHidden(!visible),
        };
    }, []);
    const readMain = React.useCallback((): ShellColumnActionOwner => {
        const { props, detailNavigation } = current.current;
        return detailNavigation ? detailNavigation.readColumn('main')
            : { ...(props.sideActions.current?.main ?? {}), ...readPhysicalMain() };
    }, [readPhysicalMain]);
    const readSide = React.useCallback((): ShellColumnActionOwner => {
        const { props, layout, detailNavigation } = current.current;
        if (detailNavigation && detailNavigation.registerSide !== false) return detailNavigation.readColumn('side');
        return {
            present: true, visible: props.rightOpen,
            available: props.sideAvailable && layout?.multiPaneEnabled === true && layout.deviceType !== 'phone',
            ...(props.sideActions.current ?? {}), setVisible: props.setSideVisible,
        };
    }, []);
    React.useLayoutEffect(() => {
        props.onControlsChange?.(value);
        return () => props.onControlsChange?.(null);
    }, [props.onControlsChange, value]);
    const arrangementAvailable = props.arrangementHonoured && layout?.multiPaneEnabled === true && layout.deviceType !== 'phone';
    React.useEffect(() => {
        if (props.focused) notifyShellColumnActionOwnersChanged();
    }, [arrangementAvailable, props.focused]);
    React.useEffect(() => {
        if (!props.focused || layout?.deviceType === 'phone') return;
        const unregisterMain = detailNavigation ? detailNavigation.bindMainColumn(readPhysicalMain)
            : registerShellColumnActionOwner('main', readMain);
        const unregisterSide = !detailNavigation || detailNavigation.registerSide === false
            ? registerShellColumnActionOwner('side', readSide) : () => {};
        return () => { unregisterMain(); unregisterSide(); };
    }, [layout?.deviceType, props.focused, props.scopeId, readMain, readPhysicalMain, readSide,
        detailNavigation?.bindMainColumn, detailNavigation?.registerSide]);
    useKeyboardShortcutHandlers(React.useMemo(() => !props.focused ? {} : ({
        'panes.main.toggle': () => { if (!canHide) return false; toggle(); return true; },
        'panes.side.toggle': () => {
            if (!props.sideAvailable || !layout?.multiPaneEnabled || layout.deviceType === 'phone') return false;
            props.setSideVisible(!props.rightOpen);
            return true;
        },
    }), [canHide, layout?.deviceType, layout?.multiPaneEnabled, props.focused, props.rightOpen, props.setSideVisible, props.sideAvailable, toggle]));
    return <PaneMainColumnContext.Provider value={value}>{props.children}</PaneMainColumnContext.Provider>;
}

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

function hasDirectPaneAdapter(props: ResolvedPaneAdapter): boolean {
    return props.surfaceScope !== undefined
        || props.rightPaneBuiltinAdapter !== undefined
        || props.rightSidebarAdapter !== undefined
        || props.detailsPaneBuiltinAdapter !== undefined
        || props.bottomPaneBuiltinAdapter !== undefined
        || props.detailsPaneEnabled !== undefined;
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
    scopeId: string;
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
    const openActions = usePaneDestinationWindowActions(props.scopeId, props.container === 'rightPane' ? 'right' : 'bottom');
    const menuActions = React.useMemo(() => openActions.presentationItems.map(item => ({
        id: item.id, title: item.title, icon: item.icon, onPress: () => { openActions.select(item.id); },
    })), [openActions]);
    const localize = usePluginLocalizedTextResolver({ projection: props.paneProjection });
    const title = resolvePluginSurfaceDestinationLabel(props.selection.placement, localize);
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
            <View style={{ flex: 1, minHeight: 0 }}>
            <PaneHeader title={title} testID={`plugin-${props.container}-header`}
                actions={<PaneHeaderActions published={null} title={title} paneMenuActions={menuActions} testID={`plugin-${props.container}`} />} />
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
            </View>
        </PluginSurfaceFocusEligibilityProvider>
    );
}

const AppPaneScopeHostContent = React.memo((props: AppPaneScopeHostProps & Readonly<{ paneAdapter: ResolvedPaneAdapter | null }>) => {
    const enclosingNavigationBinding = usePluginSurfaceDestinationNavigationBinding();
    const { dispatch, getReadState, right, bottom, detailsOverlay, detailsOpen, detailsOpenedFrom, mainHidden, overlayFocusReturnOwner } = useAppPaneContext(value => ({
        dispatch: value.dispatch,
        getReadState: value.getReadState,
        right: value.state.scopes[props.scopeId]?.right,
        bottom: value.state.scopes[props.scopeId]?.bottom,
        detailsOverlay: value.state.scopes[props.scopeId]?.details.overlay,
        detailsOpen: value.detailsStartScopeId !== props.scopeId && value.state.scopes[props.scopeId]?.details.isOpen === true,
        detailsOpenedFrom: value.state.scopes[props.scopeId]?.details.openedFrom ?? null,
        mainHidden: value.state.scopes[props.scopeId]?.mainHidden === true,
        overlayFocusReturnOwner: value.overlayFocusReturnOwner,
    }));
    const pane = useAppPaneScope(props.scopeId, () => null);
    const openPaneWindow = useOpenPaneDestinationWindow();
    const deviceType = useDeviceType();
    const appProjection = useAppShellPluginUiProjection(value => right?.selectedDestination?.kind === 'plugin'
        ? value.pluginUiProjection : null);
    const screenFocused = useDestinationFocus();
    // Activation reads the current creation input; resizing or changing preferences
    // must not activate the scope again. The reducer ignores it for retained scopes.

    // The page on screen owns the active scope; a page left behind (still mounted under the one on
    // screen) releases it, so "the current page's right sidebar" always names the page the user sees.
    React.useEffect(() => {
        if (!screenFocused) return;
        dispatch({ type: 'activateScope', scopeId: props.scopeId });
        return () => dispatch({ type: 'releaseScope', scopeId: props.scopeId });
    }, [dispatch, props.scopeId, screenFocused]);

    const rightOpen = isSelectedPaneSlotVisible(right, 'right', props.selectedPaneTabKey);
    const bottomOpen = isSelectedPaneSlotVisible(bottom, 'bottom', props.selectedPaneTabKey);
    const paneAdapter = props.paneAdapter;
    const showActionRail = useAppPaneActionRailVisible(props.scopeId, paneAdapter?.rightSidebarAdapter ?? null);
    const detailsPaneEnabled = paneAdapter?.detailsPaneEnabled !== false;
    const preference = usePaneArrangement();
    const arrangement = props.arrangement === 'honour' && deviceType !== 'phone' ? preference.arrangement : 'session';
    const destinationDetails = props.destinationDetails;
    const destinationOwnsDetails = destinationDetails !== undefined;
    const effectiveDetailsOpen = props.selectedPaneTabKey === undefined && (arrangement === 'editor' || (destinationOwnsDetails
        ? destinationDetails !== null
        : detailsPaneEnabled ? detailsOpen : false));
    const mainHiddenPreference = mainHidden;
    const resolveMainHidden = React.useCallback((layout: ResolvedPaneLayout) => (
        props.mainColumn !== undefined && mainHiddenPreference && layout.kind !== 'single'
        && (rightOpen || effectiveDetailsOpen)
    ), [effectiveDetailsOpen, mainHiddenPreference, props.mainColumn, rightOpen]);
    React.useEffect(() => {
        // Route-owned details cannot be seen by the reducer. Reconcile them here with every host.
        if (props.selectedPaneTabKey === undefined && screenFocused && mainHiddenPreference && !rightOpen && !effectiveDetailsOpen) {
            dispatch({ type: 'setMainHidden', scopeId: props.scopeId, hidden: false });
        }
    }, [dispatch, effectiveDetailsOpen, mainHiddenPreference, props.scopeId, props.selectedPaneTabKey, rightOpen, screenFocused]);
    const drawerControls = React.useRef<Readonly<{ open(): void; close(): void }> | null>(null);
    const receiveDrawerControls = React.useCallback((controls: typeof drawerControls.current) => {
        drawerControls.current = controls;
    }, []);
    const captureMainDrawerFocus = React.useCallback(() => {
        overlayFocusReturnOwner?.capture(props.scopeId, 'main');
    }, [overlayFocusReturnOwner, props.scopeId]);
    const setMainHidden = React.useCallback((hidden: boolean) => {
        if (hidden) drawerControls.current?.close(); else drawerControls.current?.open();
        dispatch({ type: 'setMainHidden', scopeId: props.scopeId, hidden });
    }, [dispatch, props.scopeId]);
    const sideActions = React.useRef<RightSidebarActions | null>(null);
    // The open tab's catalog owner reports where it presents (lab AR1 EFv); the columns follow it.
    const [rightPresentation, setRightPresentation] = React.useState<RightPanePresentation>('side');
    const rightPlacement = typeof rightPresentation === 'string' ? rightPresentation : 'side';
    const rightSurfaces = typeof rightPresentation === 'string' ? undefined : rightPresentation.surfaces;
    const presentedRightOpen = rightOpen && (typeof rightPresentation === 'string' || rightPresentation.sideVisible);
    const setSideVisible = React.useCallback((visible: boolean) => {
        dispatch({ type: visible ? 'openRight' : 'closeRight', scopeId: props.scopeId });
    }, [dispatch, props.scopeId]);

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
        selectedDestination: right?.selectedDestination,
        runtimeAdmission,
    }), [paneProjection, paneSurfaceScope, runtimeAdmission, right?.selectedDestination]);
    const rightSidebarSelection = React.useMemo(() => resolveScopedPaneDestination({
        container: 'rightSidebarTab',
        scope: paneSurfaceScope,
        projection: paneProjection,
        appProjection,
        selectedDestination: right?.selectedDestination,
        runtimeAdmission,
    }), [appProjection, paneProjection, paneSurfaceScope, runtimeAdmission, right?.selectedDestination]);
    const bottomSelection = React.useMemo(() => resolveScopedPaneDestination({
        container: 'bottomPane',
        scope: paneSurfaceScope,
        projection: paneProjection,
        selectedDestination: bottom?.selectedDestination,
        runtimeAdmission,
    }), [paneProjection, paneSurfaceScope, runtimeAdmission, bottom?.selectedDestination]);

    const rightPaneBuiltinAdapter = paneAdapter?.rightPaneBuiltinAdapter ?? null;
    const rightSidebarAdapter = paneAdapter?.rightSidebarAdapter ?? null;
    const detailsPaneBuiltinAdapter = paneAdapter?.detailsPaneBuiltinAdapter ?? null;
    const bottomPaneBuiltinAdapter = paneAdapter?.bottomPaneBuiltinAdapter ?? null;
    const openDetailsOverlay = React.useCallback<NonNullable<typeof pane.openDetailsOverlay>>((request) => {
        // Selection cannot be accepted by a host that has no Details presenter.
        if (!detailsPaneEnabled || !detailsPaneBuiltinAdapter) return false;
        return pane.openDetailsOverlay?.(request) === true;
    }, [detailsPaneBuiltinAdapter, detailsPaneEnabled, pane.openDetailsOverlay]);


    // The shared Account lifetime is the only retirement source for the
    // AppPane-private handoff. It carries no pane state and is never persisted.
    const accountLifetime = paneSurfaceScope
        ? paneSurfaceScope.accountLifetime ?? null
        : captureActiveServerAccountScopeLifetime();
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

    const openPaneDestination = React.useCallback((resolution: Parameters<typeof stagePluginSurfacePaneLaunch>[0]['resolution'], window = false) => {
        if (!stagePluginSurfacePaneLaunch({ store: paneLaunchStore, resolution })) {
            return { ok: false as const, code: 'unavailable' as const, reason: 'plugin_surface_open_origin_unavailable' };
        }
        const destination = {
            kind: 'plugin' as const,
            destination: resolution.placement.binding.destination,
            ...(resolution.request.instanceKey === undefined ? {} : { instanceKey: resolution.request.instanceKey }),
        };
        if (resolution.placement.binding.container === 'rightPane') {
            const select = () => dispatch({ type: 'selectRightDestination', scopeId: props.scopeId, destination });
            if (window || getReadState().scopes[props.scopeId]?.right.presentation) {
                return openPaneWindow(props.scopeId, selectedPaneDestinationTabKey('right'), select);
            }
            select();
            return { ok: true as const };
        }
        if (resolution.placement.binding.container === 'bottomPane') {
            const select = () => dispatch({ type: 'selectBottomDestination', scopeId: props.scopeId, destination });
            if (window || getReadState().scopes[props.scopeId]?.bottom.presentation) {
                return openPaneWindow(props.scopeId, selectedPaneDestinationTabKey('bottom'), select);
            }
            select();
            return { ok: true as const };
        }
        // The resolver's handler map below never names another container. Do
        // not turn this defensive branch into a hidden pane/sidebar fallback.
        paneLaunchStore.retire();
        return { ok: false as const, code: 'unavailable' as const, reason: 'plugin_surface_open_destination_owner_unavailable' };
    }, [dispatch, getReadState, openPaneWindow, paneLaunchStore, props.scopeId]);
    const openPaneDestinationInWindow = React.useCallback((resolution: Parameters<typeof stagePluginSurfacePaneLaunch>[0]['resolution']) => (
        openPaneDestination(resolution, true)
    ), [openPaneDestination]);
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
    const openDetailsTabWindow = React.useCallback((tab: Parameters<typeof pane.openDetailsTab>[0]) => (
        openPaneWindow(props.scopeId, tab.key, () => pane.openDetailsTab(tab))
    ), [openPaneWindow, pane.openDetailsTab, props.scopeId]);
    const openDetailsOverlayWindow = React.useCallback((overlay: Parameters<typeof openDetailsOverlay>[0]) => (
        openPaneWindow(props.scopeId, selectedPaneDestinationTabKey('detailsOverlay'), () => { openDetailsOverlay(overlay); })
    ), [openDetailsOverlay, openPaneWindow, props.scopeId]);
    const openPluginDetailsTab = React.useCallback((tab: Parameters<typeof pane.openDetailsTab>[0]) => {
        if (getReadState().scopes[props.scopeId]?.details.tabsByKey[tab.key]?.presentation) return openDetailsTabWindow(tab);
        pane.openDetailsTab(tab);
    }, [getReadState, openDetailsTabWindow, pane.openDetailsTab, props.scopeId]);
    const openPluginDetailsOverlay = React.useCallback((overlay: Parameters<typeof openDetailsOverlay>[0]) => {
        if (getReadState().scopes[props.scopeId]?.details.overlay?.presentation) return openDetailsOverlayWindow(overlay);
        return openDetailsOverlay(overlay);
    }, [getReadState, openDetailsOverlay, openDetailsOverlayWindow, props.scopeId]);
    const detailsDestinationOwners = usePluginDetailsDestinationNavigationOwners({
        targetKind: paneSurfaceScope?.targetKind ?? 'session',
        projection: paneProjection,
        mount: detailsDestinationMount,
        openTab: openPluginDetailsTab,
        openOverlay: openPluginDetailsOverlay,
        openTabWindow: openDetailsTabWindow,
        openOverlayWindow: openDetailsOverlayWindow,
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
        ? { container: 'rightPane' as const, handler: openPaneDestination, openWindow: openPaneDestinationInWindow }
        : null,
    [openPaneDestination, openPaneDestinationInWindow, paneSurfaceScope]);
    const bottomPaneOwner = React.useMemo(() => paneSurfaceScope
        ? { container: 'bottomPane' as const, handler: openPaneDestination, openWindow: openPaneDestinationInWindow }
        : null,
    [openPaneDestination, openPaneDestinationInWindow, paneSurfaceScope]);
    const detailsTabOwner = React.useMemo(() => (
        paneSurfaceScope && detailsDestinationOwners
            ? { container: 'detailsTab' as const, handler: detailsDestinationOwners.detailsTab, openWindow: detailsDestinationOwners.detailsTabWindow }
            : null
    ), [detailsDestinationOwners, paneSurfaceScope]);
    const detailsPaneOwner = React.useMemo(() => (
        paneSurfaceScope && detailsDestinationOwners
            ? { container: 'detailsPane' as const, handler: detailsDestinationOwners.detailsPane, openWindow: detailsDestinationOwners.detailsPaneWindow }
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
            scopeId={props.scopeId}
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
        props.scopeId,
    ]);

    // `MultiPaneHost` uses pane node presence as the logical "open" signal. Keep the
    // nodes null when closed so hidden layouts don't accidentally mount expensive panes.
    // A selection is durable identity, not a right-pane fallback hint. The
    // right-sidebar resolver can name one of three useful facts: this is an
    // admitted tab, its projection has not settled yet, or its own destination
    // is unavailable. Only a known binding for another container proceeds to
    // the direct right-pane resolver; otherwise retain the selected tab's own
    // tombstone reason rather than recasting it as a container mismatch.
    const selectedRightDestinationIsSidebarTab = right?.selectedDestination?.kind === 'plugin'
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
                        selectedDestination: right?.selectedDestination,
                        scopeId: props.scopeId,
                    });
    const detailsPane = props.selectedPaneTabKey !== undefined ? null : destinationOwnsDetails
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
                        selectedDestination: bottom?.selectedDestination,
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
            <RightSidebarActionsContext.Provider value={sideActions}>
            <RightPanePlacementReporterContext.Provider value={setRightPresentation}>
                <AppPaneScopeControls
                    scopeId={props.scopeId}
                    focused={screenFocused}
                    descriptor={props.mainColumn}
                    rightOpen={presentedRightOpen}
                    detailsOpen={effectiveDetailsOpen}
                    sideAvailable={(rightSidebarAdapter !== null && rightSidebarAdapter.available !== false) || rightPaneBuiltinAdapter !== null}
                    arrangementHonoured={props.arrangement === 'honour'}
                    onControlsChange={props.onMainColumnControlsChange}
                    setHidden={setMainHidden}
                    setSideVisible={setSideVisible}
                    sideActions={sideActions}
                >
                    {wrapScopeContent ? wrapScopeContent(content) : content}
                </AppPaneScopeControls>
            </RightPanePlacementReporterContext.Provider>
            </RightSidebarActionsContext.Provider>
        </PluginSurfaceDestinationNavigationBindingProvider>
    ), [effectiveDetailsOpen, enclosingNavigationBinding, paneNavigationBinding, props.arrangement, props.mainColumn, props.onMainColumnControlsChange, props.scopeId,
        presentedRightOpen, rightPaneBuiltinAdapter, rightSidebarAdapter, screenFocused, setMainHidden, setSideVisible, wrapScopeContent]);

    if (props.selectedPaneTabKey !== undefined) {
        const selectedSlot = readSelectedPaneDestinationSlot(props.selectedPaneTabKey);
        const selected = selectedSlot === 'right' ? rightPane : selectedSlot === 'bottom' ? bottomPane
            : selectedSlot === 'detailsOverlay' && detailsOverlay && paneSurfaceScope
                ? <PluginDetailsPaneOverlay targetKind={paneSurfaceScope.targetKind} projection={paneProjection}
                    mount={detailsDestinationMount} overlay={detailsOverlay} />
                : <PaneLoadingFallback />;
        return wrapContent(<>{selected}</>);
    }


    return (
        <PaneColumnsHost
            main={props.main}
            mainAccessibilityLabel={props.mainColumn?.showLabel}
            mainMinWidthPx={props.mainMinWidthPx}
            detailsPreferredWidthPx={props.detailsPreferredWidthPx}
            rightPane={presentedRightOpen ? rightPane : null}
            rightSurfaces={rightSurfaces}
            onCloseMainSurface={typeof rightPresentation === 'string' ? undefined : rightPresentation.onCloseMainSurface}
            detailsPane={detailsPane}
            bottomPane={bottomPane}
            rightOpen={presentedRightOpen}
            rightPlacement={rightOpen ? rightPlacement : 'side'}
            detailsOpen={effectiveDetailsOpen}
            destinationOwnsDetails={destinationOwnsDetails}
            detailsOpenedFrom={detailsOpenedFrom}
            bottomOpen={bottomOpen}
            arrangement={arrangement}
            mainHidden={props.mainColumn !== undefined && mainHiddenPreference}
            resolveMainHidden={resolveMainHidden}
            onSetMainHidden={setMainHidden}
            onMainDrawerControlsChange={receiveDrawerControls}
            onBeforeMainDrawerOpen={captureMainDrawerFocus}
            emptyEditorPane={props.emptyEditorPane}
            actionRail={showActionRail ? rightSidebarAdapter?.renderActionRail?.({ scopeId: props.scopeId }) ?? null : null}
            onCloseRight={onCloseRight}
            onCloseDetails={onCloseDetails}
            onCloseBottom={onCloseBottom}
            rightOverlayFocusReturnRef={pane.rightOverlayFocusReturnRef}
            detailsOverlayFocusReturnRef={pane.detailsOverlayFocusReturnRef}
            bottomOverlayFocusReturnRef={pane.bottomOverlayFocusReturnRef}
            mainOverlayFocusReturnRef={pane.mainOverlayFocusReturnRef}
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
export const AppPaneScopeHost = React.memo((props: AppPaneScopeHostProps) => {
    const directProps = React.useRef(props);
    directProps.current = props;
    const registeredDirectDriver = React.useRef<PaneDriver | null>(null);
    const subscription = React.useContext(AppPaneContext);
    const { driver, getDriver, registerDriver } = useAppPaneContext(value => {
        const driver = value.getDriver(props.scopeId);
        // Selected destination hosts also observe adapter changes on the stable driver.
        return { ...(driver === registeredDirectDriver.current ? null : driver),
            driver, getDriver: value.getDriver, registerDriver: value.registerDriver };
    });
    // Editing a route changes render closures, not the lifetime of its pane driver.
    const hasDirectAdapter = hasDirectPaneAdapter(props);
    const directDriver = React.useMemo<PaneDriver | null>(() => hasDirectAdapter ? {
        scopeId: props.scopeId,
        get surfaceScope() { return directProps.current.surfaceScope; },
        get rightPaneBuiltinAdapter() { return directProps.current.rightPaneBuiltinAdapter; },
        get rightSidebarAdapter() { return directProps.current.rightSidebarAdapter; },
        get detailsPaneBuiltinAdapter() { return directProps.current.detailsPaneBuiltinAdapter; },
        get bottomPaneBuiltinAdapter() { return directProps.current.bottomPaneBuiltinAdapter; },
        get detailsPaneEnabled() { return directProps.current.detailsPaneEnabled; },
    } : null, [props.scopeId, hasDirectAdapter]);
    const externalDriver = driver === registeredDirectDriver.current ? null : driver;
    React.useEffect(() => {
        if (!directDriver) return;
        // A child can register its driver earlier in this same effect flush.
        const incumbent = getDriver(directDriver.scopeId);
        if (incumbent && incumbent !== registeredDirectDriver.current) return;
        // The physical host and Start sheet consume the same registered adapter.
        // Remember our registration so an updated direct adapter retains its body.
        registeredDirectDriver.current = directDriver;
        const retire = registerDriver(directDriver);
        return () => {
            retire();
            registeredDirectDriver.current = null;
        };
    }, [directDriver, externalDriver, getDriver, registerDriver]);
    React.useLayoutEffect(() => {
        if (directDriver) subscription?.notifyDriverUpdated(directDriver);
    }, [directDriver, subscription, props.surfaceScope, props.rightPaneBuiltinAdapter,
        props.rightSidebarAdapter, props.detailsPaneBuiltinAdapter, props.bottomPaneBuiltinAdapter,
        props.detailsPaneEnabled]);
    // An independently registered driver and direct props remain an authority
    // collision; the host never picks one of two competing producers.
    const paneAdapter: ResolvedPaneAdapter | null = externalDriver && directDriver ? null : externalDriver ?? directDriver;
    const surfaceScope = paneAdapter?.surfaceScope;
    return <PluginDetailsDestinationLaunchScope accountLifetime={surfaceScope !== undefined
        ? surfaceScope.accountLifetime ?? null
        : undefined}>
        <AppPaneScopeHostContent {...props} paneAdapter={paneAdapter} />
    </PluginDetailsDestinationLaunchScope>;
});
