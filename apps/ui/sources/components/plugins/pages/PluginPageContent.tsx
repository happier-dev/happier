import * as React from 'react';
import { NavigationContext } from '@react-navigation/native';
import { PluginUiSetUnsavedChangesRequestV1Schema } from '@happier-dev/protocol/plugins/ui';
import { useDestinationPageTitle } from '@/components/appShell/workspace/DestinationInstanceHost';
import { Platform, View } from 'react-native';
import { Stack } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationFocus, useDestinationRouter, useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';

import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { PluginPageBackStepProvider } from '@/components/plugins/shared/PluginPageBackStep';
import { PluginPageIdentityHeaderProvider } from '@/components/plugins/shared/PluginPageIdentityHeader';
import { PluginMachineExecutionOriginSelectorView } from '@/components/settings/machines/PluginMachineExecutionOriginSelector';
import { NavigationLargeTitleProvider, useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { PluginPagePresentation } from './PluginPagePresentation';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';
import { RouteRemovalStepConsumer } from '@/utils/navigation/RouteRemovalStepConsumer';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';
import { createPluginSurfaceHostApiError, type PluginSurfaceHostApiMethodHandler } from '@/components/plugins/surfaces/createPluginSurfaceHostApi';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { HAPPIER_PAGE_METRICS, HappierColumnEdgeContext } from '@happier-dev/plugin-ui/presentation';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { resolveSelectedPluginSurfaceLaunchAuthority } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { isPluginSurfaceMachineBound, usePluginSurfaceExecutionOrigin } from '@/components/plugins/surfaces/pluginSurfaceExecutionOrigin';
import { t } from '@/text';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { usePluginDetailNavigation } from './pluginDetailNavigation';
import { PluginPageNavigationContext } from './pluginPageNavigationContext';

import type { AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolvePluginPageForRoute, type PluginPage } from './pluginPages';
import type { PluginUiPolicyEvaluationContext } from '@/sync/domains/plugins/ui/policy';
import {
    usePluginPageLaunch,
} from '@/components/plugins/pages/pluginPageNavigation';
import { createPluginPageLocationOwner, type PluginPageLocationOwner } from '@/components/plugins/pages/pluginPageLocation';
import { pluginPageTargetKey } from './pluginPageRoute';
import {
    PluginPageHeaderActions,
    resolvePluginPageHeaderActions,
} from '@/components/plugins/pages/pluginPageHeaderActions';

/**
 * The host route surface for `app.page` plugin destinations (EU-5b).
 *
 * The host owns the route — `/plugins/<pluginId>/<localId>/*` — and the plugin
 * owns everything under it. This screen resolves the qualified page from the
 * two identity segments, hands the surface only the remainder as `subPath`, and
 * mounts it through the SAME `PluginSurfacePlacementHost` every other placement
 * uses, so a page is not a second mount path.
 *
 * A page that is missing, disabled, stale, uninstalled or blocked by policy
 * degrades VISIBLY here: the catalog resolves it to a `disabledReason` and the
 * route renders the canonical unavailable surface rather than a blank screen or
 * a redirect that would hide the fact from the user.
 */
/**
 * A plugin page is a work surface the plugin composes, like the host's own
 * list/detail collections (Settings → Agents, Providers), which fill their
 * page. It takes the host page gutter — the inset page sheets and headers use —
 * so no page sits flush against the window edge, and the full width, so a
 * list beside its detail is not squeezed into the reading measure. Reading
 * content inside a page keeps its own measure (state tiles, prose).
 */
const pageContentFrameStyle = {
    flex: 1,
    width: '100%',
    paddingHorizontal: resolveItemGroupContentHorizontalInsetPx(),
} as const;

/**
 * The page gutter is already the page's sheet edge (as on a core page, `CoreCollectionScope`): a plain block the
 * plugin composes (a toolbar, a banner, a facts strip, a card) stands on it beside the sheets, and the
 * self-insetting anatomy (sheets, section titles, the page header, states) subtracts it instead of insetting again.
 */
const PLUGIN_PAGE_COLUMN_EDGE_PX = HAPPIER_PAGE_METRICS.sheetInsetPx;

/** Machine presentation updates belong to route controls, not the page identity. */
function PluginPageRouteActions(props: Readonly<{
    pluginId: string;
    page: PluginPage | null;
    projection: AppShellPluginUiProjectionValue['pluginUiProjection'];
    surfaceTarget?: Parameters<typeof usePluginSurfaceExecutionOrigin>[0]['surfaceTarget'];
    compact: boolean;
    headerActions: Omit<React.ComponentProps<typeof PluginPageHeaderActions>, 'isDaemonExecutionCurrent'> | null;
}>): React.ReactElement {
    const needsMachineExecution = !!props.page && isPluginSurfaceMachineBound({
        pluginId: props.pluginId,
        surface: props.page.placement,
        projection: props.projection,
    });
    const execution = usePluginSurfaceExecutionOrigin({
        pluginId: props.pluginId,
        projection: props.projection,
        entry: props.page?.placement,
        enabled: needsMachineExecution,
        surfaceTarget: props.page?.placement.target.kind === 'project' ? props.surfaceTarget : undefined,
    });
    return <>
        {needsMachineExecution ? <PluginMachineExecutionOriginSelectorView pluginId={props.pluginId} selection={execution.selection} presentation="chip" compact={props.compact}
            groupTitle={t('settingsPlugins.executionOriginTitle')} testIDPrefix="plugin-page-execution" /> : null}
        {props.headerActions ? <PluginPageHeaderActions {...props.headerActions}
            isDaemonExecutionCurrent={execution.isExecutionOriginCurrent} /> : null}
    </>;
}

export function PluginPageContent(props: Readonly<{
    page: PluginPage | null;
    /**
     * The route's page catalog, where a page that presents another of its plugin's declared views a lens apart
     * (`replacePageLocation` `view`) finds that view's title. Absent: the chrome names the mounted page.
     */
    views?: readonly PluginPage[];
    projection: AppShellPluginUiProjectionValue;
    routePathFor: (subPath: string, view: string | null) => string;
    /** The declared view the route names (`?view=`): the chrome titles it from the first frame of a cold load. */
    initialView?: string | null;
    projectContext?: React.ComponentProps<typeof PluginSurfacePlacementHost>['projectContext'];
    policyContext?: PluginUiPolicyEvaluationContext;
    appChrome?: boolean;
    accountScopeRestoring?: boolean;
    /** The target adapter chooses its incumbent physical host inside page focus/visibility. */
    renderContent?: (content: React.ReactElement) => React.ReactNode;
    pluginId: string;
    localId: string;
    /** Canonical plugin-local location; `''` at the page root. */
    subPath: string | null;
}>): React.ReactElement {
    const isFocused = useDestinationFocus();
    const isVisible = useDestinationVisibility();
    const router = useDestinationRouter();
    const projection = props.projection;
    const page = props.page;

    const accountLifetime = projection.accountLifetime;
    // An app-scope projection is a catalog union, so its top-level machine and
    // generation are intentionally absent when more than one contributor is
    // selected. Page chrome belongs to this exact admitted page instead: reuse
    // the selected-origin resolver that already fences launch authority rather
    // than falling back to the aggregate projection.
    const pageHeaderActionAuthority = React.useMemo(() => (
        resolveSelectedPluginSurfaceLaunchAuthority({
            placement: page?.placement ?? null,
            accountLifetime,
        })
    ), [accountLifetime, page?.placement]);
    // Header actions are host chrome rather than a mounted plugin renderer,
    // but they still make daemon-backed Action calls. This scope only borrows
    // the incumbent Account lifetime and component/projection lifetime so the
    // canonical dispatcher can cancel and reject a retired header invocation.
    const pageHeaderActionScope = React.useMemo(
        () => new AbortController(),
        [accountLifetime, page, pageHeaderActionAuthority, projection.pluginUiProjection],
    );
    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(() => pageHeaderActionScope.abort());
        return () => {
            retirement?.dispose();
            pageHeaderActionScope.abort();
        };
    }, [accountLifetime, pageHeaderActionScope]);
    const isPageHeaderActionCurrent = React.useCallback(() => (
        !pageHeaderActionScope.signal.aborted
        && accountLifetime?.isCurrent() === true
    ), [accountLifetime, pageHeaderActionScope]);
    const appTargetBinding = usePluginSurfaceDestinationNavigationBinding();
    // A page contributes no local resolver: every mounted surface delegates
    // through the one app-target binding installed by the shell.
    const openSurface = appTargetBinding?.openSurface;

    // `NAV-2`/`NAV-3`. The page's own location — replaced, never pushed — and
    // the one page-internal step system Back returns to. Both are the same
    // owner because they are the same fact: a page-internal Back step is a
    // location, declared by the replacement that created the step it undoes.
    //
    // The live location and mount currentness are read through refs so the
    // owner's identity is the PAGE's, not a value that changes on every
    // navigation. Rebuilding it per location would rearm a fresh participant
    // mid-interaction and lose the step the user is standing on.
    const pageLocationRef = React.useRef<string | null>(props.subPath);
    pageLocationRef.current = props.subPath;
    const pageIsMountedRef = React.useRef(true);
    React.useEffect(() => {
        pageIsMountedRef.current = true;
        return () => { pageIsMountedRef.current = false; };
    }, []);
    const pageTargetKey = page ? pluginPageTargetKey(page.target) : null;
    // One dirty fact per physical page/Account/target, with synchronous admission
    // and notifications only on transitions. No edited content crosses this seam.
    const dirtyOwner = React.useMemo(() => {
        let isDirty = false;
        const listeners = new Set<() => void>();
        const dirty = {
            get current() { return isDirty; },
            set current(next: boolean) {
                if (isDirty === next) return;
                isDirty = next;
                for (const listener of listeners) listener();
            },
        };
        return {
            dirty,
            getSnapshot: () => isDirty,
            subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            publish: (next: boolean) => { dirty.current = next; },
        };
    }, [accountLifetime, pageTargetKey, props.localId, props.pluginId]);
    const hasUnsavedChanges = React.useSyncExternalStore(dirtyOwner.subscribe, dirtyOwner.getSnapshot, dirtyOwner.getSnapshot);
    const dirtyFact = dirtyOwner.dirty;
    const publishDirty = dirtyOwner.publish;
    const targetKeyRef = React.useRef(pageTargetKey);
    targetKeyRef.current = pageTargetKey;
    React.useLayoutEffect(() => {
        const retirement = accountLifetime?.onRetire(() => publishDirty(false));
        return () => retirement?.dispose();
    }, [accountLifetime, publishDirty]);
    const locationOwnerRef = React.useRef<PluginPageLocationOwner | null>(null);
    const performPageBack = React.useCallback(() => {
        if (!locationOwnerRef.current?.consumeBack()) router.back();
    }, [router]);
    const canLeaveHistoryWithoutDiscard = React.useCallback(() => locationOwnerRef.current?.hasPreservingBackStep() === true, []);
    const discardDirtyFact = React.useCallback(() => publishDirty(false), [publishDirty]);
    const captureDecisionCurrentness = React.useCallback(() => {
        const location = pageLocationRef.current;
        const target = targetKeyRef.current;
        return () => pageIsMountedRef.current && accountLifetime?.isCurrent() === true
            && pageLocationRef.current === location && targetKeyRef.current === target;
    }, [accountLifetime]);
    const navigation = React.useContext(NavigationContext);
    const departure = useUnsavedDraftNavigationGuard({ navigation, isDirty: hasUnsavedChanges, isDirtyRef: dirtyFact,
        onDiscard: discardDirtyFact, onBack: performPageBack, captureDecisionCurrentness, canLeaveHistoryWithoutDiscard, tag: 'PluginPageContent.unsavedChanges' });
    const requestDeparture = departure.requestLeaveAndWait;
    const allowPreservingReplacement = page?.placement.renderer.kind === 'reactNative';
    // Read once per owner: later routes this owner writes carry the view it settled, not the one the mount arrived on.
    const initialViewRef = React.useRef(props.initialView ?? null);
    initialViewRef.current = props.initialView ?? null;
    const locationOwner = React.useMemo(() => createPluginPageLocationOwner({
        currentSubPath: () => pageLocationRef.current,
        initialView: initialViewRef.current,
        routePathFor: props.routePathFor,
        replaceLocation: (routePath) => {
            router.replace(routePath as Parameters<typeof router.replace>[0]);
        },
        isCurrent: () => pageIsMountedRef.current && accountLifetime?.isCurrent() !== false,
        beforeReplace: options => requestDeparture(() => pageIsMountedRef.current
            && accountLifetime?.isCurrent() === true && options?.signal?.aborted !== true),
        allowPreservingReplacement,
    }), [accountLifetime, allowPreservingReplacement, props.localId, props.pluginId, props.routePathFor, requestDeparture, router]);
    locationOwnerRef.current = locationOwner;
    React.useEffect(() => () => locationOwner.dispose(), [locationOwner]);
    const pageIsLive = props.subPath !== null && !!page && page.disabledReason === null;
    // Addressed by the ROUTE, not by the resolved catalog entry: the launch
    // input belongs to the navigation that carried it, so it must be delivered
    // — and, when this location is not a live page, retired — from the same two
    // identity segments plus the plugin-local location the user arrived at.
    const launch = usePluginPageLaunch({
        pluginId: props.pluginId,
        localId: props.localId,
        subPath: props.subPath,
    });
    // A companion opened from this page shows the page's own entity: its launch input and current location.
    const pageLaunchInput = launch?.input;
    const surfaceInput = React.useMemo(() => ({
        ...(pageLaunchInput === undefined ? {} : { launchInput: pageLaunchInput }), subPath: props.subPath,
    }), [pageLaunchInput, props.subPath]);
    const detailNavigation = usePluginDetailNavigation({ identity: `${props.pluginId}/${props.localId}`,
        lifetime: accountLifetime, scope: accountLifetime?.scope ?? null, live: pageIsLive,
        presented: isFocused && isVisible, title: page?.label ?? props.pluginId, openSurface, surfaceInput });
    const setPageNavigation = React.useCallback<PluginSurfaceHostApiMethodHandler>(request =>
        detailNavigation.owner.setPageNavigation(request.payload), [detailNavigation.owner]);
    const scopeActionOwner = React.useMemo(() => ({ kind: 'shell.columns' as const,
        columns: { main: () => detailNavigation.readColumn('main') },
    }), [detailNavigation.readColumn]);
    // A location this owner did not settle on — a push, a deep link, or the
    // user's own history walk — retires the declared step. Losing the live
    // page does the same even if its route sub-path has not moved; otherwise a
    // later renderer could inherit a Back step declared by a retired one.
    React.useEffect(() => {
        locationOwner.retireForeignLocationChange(pageIsLive ? props.subPath : null);
    }, [locationOwner, pageIsLive, props.subPath]);
    // Registered through the app's ONE native-Back layer owner for the whole
    // focused lifetime of a live page, rather than only while a step is
    // declared. React Native dispatches Back in REVERSE registration order, so
    // a listener that came and went with plugin state would keep changing its
    // position relative to overlays that registered later; a stable
    // registration keeps "overlay first, then the page, then ordinary
    // navigation" true no matter when the plugin declared its step. Going
    // through the layer owner rather than `BackHandler` directly is what makes
    // an enclosing pane yield to this page, and what keeps a retained,
    // invisible underlay from answering a Back the user aimed at what they see.
    const consumePageBack = React.useCallback(() => {
        if (dirtyFact.current) {
            departure.requestBack();
            return true;
        }
        return locationOwner.consumeBack();
    }, [departure.requestBack, dirtyFact, locationOwner]);
    useNativeBackLayerBackHandler(
        Platform.OS === 'android' && isFocused && pageIsLive,
        consumePageBack,
    );
    // Escape is the desktop and web keyboard's Back, and it is NOT navigation:
    // it has to be ordered against the overlays, popovers, palettes and modals
    // that must consume it first. That ordering is the app's Escape layer stack,
    // so the page joins it at pane priority rather than installing a key
    // listener of its own. Yielding (`false`) when the page has no step is what
    // lets a lower layer — a session surface, a draft — answer the same press.
    const consumePageEscape = React.useCallback(() => consumePageBack(), [consumePageBack]);
    useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.pane,
        enabled: isFocused && pageIsLive,
        onEscape: consumePageEscape,
    });

    const setUnsavedChanges = React.useCallback<PluginSurfaceHostApiMethodHandler>(request => {
        const payload = PluginUiSetUnsavedChangesRequestV1Schema.safeParse(request.payload);
        if (!payload.success) return createPluginSurfaceHostApiError('invalid_payload', ['plugin_page_unsaved_changes_invalid']);
        publishDirty(payload.data.isDirty);
        return {};
    }, [publishDirty]);
    const binding = React.useMemo<BoundPluginSurfaceBinding>(() => ({
        ...(openSurface ? { openSurface } : {}),
        scopeActionOwner,
        isCurrentUiContextLocationOwned: locationOwner.ownsCurrentLocation,
        // Only a live page has a location to replace. Elsewhere the method is
        // not installed, so the mount truthfully does not advertise it.
        ...(pageIsLive
            ? {
                mountedHostApiHandlers: {
                    replacePageLocation: locationOwner.handleReplaceRequest,
                    setUnsavedChanges,
                    setPageNavigation,
                },
                disposeMountedHostApiHandlers: detailNavigation.owner.clear,
            }
            : {}),
    }), [locationOwner, openSurface, pageIsLive, setUnsavedChanges, setPageNavigation, detailNavigation.owner, scopeActionOwner]);
    const recoveryAction = React.useMemo(() => ({
        label: t('settingsPlugins.managePlugin'),
        onPress: () => { router.push(buildPluginDetailRoute('settings', props.pluginId)); },
    }), [props.pluginId, router]);


    const phoneTitleChrome = useNavigationTitleChromeShowsTitle();
    // The page names the declared view on screen: one page may present several of its plugin's views a lens apart.
    const settledView = React.useSyncExternalStore(locationOwner.subscribe, locationOwner.selectedView, locationOwner.selectedView);
    // The route's `?view=` is the view on screen until the page settles another: losing liveness for a moment (its
    // execution origin revalidating) retires the owner's step and view without any location change.
    const selectedView = settledView ?? props.initialView ?? null;
    const viewPage = selectedView === null || props.views === undefined ? null
        : resolvePluginPageForRoute({ pages: props.views, pluginId: props.pluginId, localId: selectedView });
    const chromeTitle = (viewPage ?? page)?.label ?? null;
    const headerTitle = chromeTitle ?? t('pluginSurfaces.appPage.title');

    const pageHeaderActions = React.useMemo(
        () => resolvePluginPageHeaderActions(page),
        [page],
    );
    const activePageForHeader = pageIsLive ? page : null;
    const routeActions = React.useMemo(() => <PluginPageRouteActions
        pluginId={props.pluginId}
        page={page}
        projection={projection.pluginUiProjection}
        compact={phoneTitleChrome}
        surfaceTarget={props.projectContext?.target}
        headerActions={activePageForHeader && openSurface && pageHeaderActions.length > 0 ? {
            actions: pageHeaderActions,
            page: activePageForHeader,
            projection: projection.pluginUiProjection,
            actionAuthority: pageHeaderActionAuthority,
            openSurface,
            signal: pageHeaderActionScope.signal,
            isCurrent: isPageHeaderActionCurrent,
        } : null}
    />, [
        activePageForHeader,
        openSurface,
        pageHeaderActions,
        pageHeaderActionScope.signal,
        projection.pluginUiProjection,
        pageHeaderActionAuthority,
        isPageHeaderActionCurrent,
        page,
        props.pluginId,
        props.projectContext?.target,
        phoneTitleChrome,
    ]);
    const headerOptions = React.useMemo(() => ({ headerTitle, headerRight: () => routeActions }), [headerTitle, routeActions]);
    // A phone's top-level collection page (an app page whose header is its Collection toolbar) leads with its name as
    // its large title under the navigation row, as the Inbox tab does (lab `merged-list` 390, `phone-P4`); the bar then
    // carries Back and the page's controls only. Wide layouts keep the name in the toolbar row.
    const largeTitle = props.appChrome === true && page?.headerStyle === 'toolbar' && phoneTitleChrome;
    const pageHeaderOptions = React.useMemo(() => largeTitle ? { ...headerOptions, headerTitle: '' } : headerOptions,
        [headerOptions, largeTitle]);
    const renderPage = (body: React.ReactNode) => <PluginPagePresentation pluginId={props.pluginId} localId={props.localId}
        accountScope={accountLifetime?.scope ?? null} visible={isVisible}
        demandProjection={props.subPath !== null && (page ? !page.disabledReason && isPluginSurfaceMachineBound({
            pluginId: props.pluginId, surface: page.placement, projection: projection.pluginUiProjection,
        }) : projection.phase === 'establishing' || projection.hasEstablishingMembers)}
        actions={routeActions}>{body}</PluginPagePresentation>;

    // A declared page keeps its physical host while execution revalidates.
    // The host owns its notice and retention; only a missing declaration waits here.
    if (props.subPath !== null && !page && (projection.phase === 'establishing' || projection.hasEstablishingMembers
        || (accountLifetime === null && props.accountScopeRestoring))) {
        return renderPage(
            <>
                {props.appChrome ? <PluginPageRouteChrome title={null} options={headerOptions} /> : null}
                <View testID="plugin-app-page-establishing" style={pageContentFrameStyle}>
                    <PluginSurfaceFallback testID="plugin-app-page-loading" state="loading" />
                </View>
            </>
        );
    }

    if (props.subPath === null || !page || page.disabledReason) {
        const unavailableReasonCode = props.subPath === null
            ? 'plugin_surface_open_sub_path_invalid'
            : page?.disabledReasonCode ?? page?.disabledReason ?? projection.unavailableReasonCode ?? 'plugin_app_page_unavailable';

        return renderPage(
            <>
                {props.appChrome ? <PluginPageRouteChrome title={chromeTitle} options={headerOptions} /> : null}
                <PluginSurfaceFallback
                    testID="plugin-app-page-unavailable"
                    subjectName={props.pluginId}
                    reasonCode={unavailableReasonCode}
                    reason={page?.disabledReasonCode ? page.disabledReason ?? undefined : undefined}
                    action={recoveryAction}
                />
            </>
        );
    }

    // Visibility pauses the plugin renderer, not the page's physical pane owner. Opening an
    // approval retains this destination; unmounting renderContent would cancel its pending command.
    const pageContent = isVisible ? (
                <View testID="plugin-app-page-host" style={pageContentFrameStyle}>
                    <HappierColumnEdgeContext.Provider value={PLUGIN_PAGE_COLUMN_EDGE_PX}>
                    <PluginPageBackStepProvider owner={locationOwner}>
                    <NavigationLargeTitleProvider largeTitle={largeTitle}>
                    <PluginPageIdentityHeaderProvider pluginId={props.pluginId} title={headerTitle} description={page.description} headerStyle={page.headerStyle}
                        largeTitle={largeTitle}
                        // A Machine or Project page is a tab under that host's own header (plan 30 §3.7): that header is its
                        // identity, so a page still loading draws no second title that leaves when it arrives.
                        identityOwner={page.target.kind === 'machine' || page.target.kind === 'project' ? 'host' : 'page'}>
                    <PluginPageNavigationContext.Provider value={detailNavigation.projection}>
                    <PluginSurfacePlacementHost
                        placement={page.placement}
                        projectContext={props.projectContext}
                        projectId={props.projectContext?.target?.checkout?.id}
                        policyContext={props.policyContext}
                        pluginUiProjection={projection.pluginUiProjection}
                        machineId={page.target.kind === 'machine' ? page.target.machineId : projection.machineId}
                        serverId={page.target.kind === 'machine' ? page.target.serverId : projection.serverId}
                        platform={projection.platform}
                        binding={binding}
                        subPath={props.subPath}
                        launchInput={launch?.input}
                        launch={launch ?? undefined}
                        mountInstanceKey={launch?.instanceKey}
                        unavailableAction={recoveryAction}
                        projectionInteractionEnabled={projection.phase === 'current'
                            && projection.interactionEnabled}
                    />
                    </PluginPageNavigationContext.Provider>
                    </PluginPageIdentityHeaderProvider>
                    </NavigationLargeTitleProvider>
                    </PluginPageBackStepProvider>
                    </HappierColumnEdgeContext.Provider>
                </View>
    ) : <React.Fragment />;

    return renderPage(
        <>
            {props.appChrome ? <PluginPageRouteChrome title={chromeTitle} options={pageHeaderOptions} /> : null}
            {/*
                The other three ways back, in one participant.
                `useNativeBackLayerBackHandler` above answers Android's hardware
                Back; a browser's Back button, an iOS header Back and an iOS
                edge-swipe are all one fact instead — the route is being REMOVED
                — and the shared consumer spends the page's declared step before
                that happens. Without it a page-internal Back existed on exactly
                one of the four platforms Happier ships, and every other client
                left the page while its own detail stayed open behind it.
            */}
            <RouteRemovalStepConsumer active={isFocused && pageIsLive && !hasUnsavedChanges} consume={consumePageBack} />
            <PluginSurfaceFocusEligibilityProvider
                active={isFocused}
                presentationActive={isVisible}
                currentUiContextActive={isFocused}
            >
                {/*
                    The page's app details pane: a plugin's `DetailsPane` (and a
                    `Collection` opening its items) renders beside the page in the
                    same pane every destination uses.
                */}

                {props.renderContent ? props.renderContent(pageContent) : pageContent}

            </PluginSurfaceFocusEligibilityProvider>
        </>
    );
}

function PluginPageRouteChrome(props: Readonly<{
    title: string | null;
    options: React.ComponentProps<typeof Stack.Screen>['options'];
}>): React.ReactElement {
    useDestinationPageTitle(props.title);
    return <Stack.Screen options={props.options} />;
}
