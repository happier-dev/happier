import * as React from 'react';
import { Platform, View } from 'react-native';
import { Stack } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationFocus, useDestinationRouter, useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';

import { DetailsPaneSlotHost } from '@/components/appShell/panes/details/DetailsPaneSlot';
import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';
import { RouteRemovalStepConsumer } from '@/utils/navigation/RouteRemovalStepConsumer';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { resolveSelectedPluginSurfaceLaunchAuthority } from '@/components/plugins/surfaces/pluginSurfaceLaunchAuthority';
import { isPluginSurfaceMachineBound, usePluginSurfaceExecutionOrigin } from '@/components/plugins/surfaces/pluginSurfaceExecutionOrigin';
import { readSelectedPluginUiResourceCapability } from '@/sync/domains/plugins/ui/resourceCapability';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';

import {
    useAppShellPluginUiProjection,
    useProjectedPluginLocalizedTextResolver,
} from './AppShellPluginUiProjection';
import {
    buildPluginAppPageRoutePath,
    resolvePluginAppPageForRoute,
    resolvePluginAppPages,
    selectPluginAppPagePlacements,
} from './pluginAppPages';
import {
    usePluginAppPageLaunch,
} from './pluginAppPageNavigation';
import { createPluginAppPageLocationOwner } from './pluginAppPageLocation';
import {
    PluginAppPageHeaderActions,
    resolvePluginAppPageHeaderActions,
} from './pluginAppPageHeaderActions';

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

export function PluginAppPageScreen(props: Readonly<{
    pluginId: string;
    localId: string;
    /** Canonical plugin-local location; `''` at the page root. */
    subPath: string | null;
}>): React.ReactElement {
    const isFocused = useDestinationFocus();
    const isVisible = useDestinationVisibility();
    const router = useDestinationRouter();
    const projection = useAppShellPluginUiProjection();
    const localize = useProjectedPluginLocalizedTextResolver();
    const placements = React.useMemo(
        () => selectPluginAppPagePlacements(projection.pluginUiProjection),
        [projection.pluginUiProjection],
    );
    const pages = React.useMemo(
        () => resolvePluginAppPages({ placements, localize }),
        [localize, placements],
    );
    const page = React.useMemo(() => resolvePluginAppPageForRoute({
        pages,
        pluginId: props.pluginId,
        localId: props.localId,
    }), [pages, props.localId, props.pluginId]);

    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const pageExecution = usePluginSurfaceExecutionOrigin({
        pluginId: props.pluginId,
        projection: projection.pluginUiProjection,
        entry: page?.placement,
        enabled: !!page && isPluginSurfaceMachineBound({
            pluginId: props.pluginId,
            renderer: page.placement.renderer,
            projection: projection.pluginUiProjection,
            headerActions: page.placement.headerActions,
            resourceCapability: readSelectedPluginUiResourceCapability(page.placement),
        }),
    });
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
    const locationOwner = React.useMemo(() => createPluginAppPageLocationOwner({
        currentSubPath: () => pageLocationRef.current,
        routePathFor: (subPath) => buildPluginAppPageRoutePath({
            pluginId: props.pluginId,
            localId: props.localId,
            subPath,
        }),
        replaceLocation: (routePath) => {
            router.replace(routePath as Parameters<typeof router.replace>[0]);
        },
        isCurrent: () => pageIsMountedRef.current && accountLifetime?.isCurrent() !== false,
    }), [accountLifetime, props.localId, props.pluginId, router]);
    React.useEffect(() => () => locationOwner.dispose(), [locationOwner]);
    const pageIsLive = props.subPath !== null && !!page && page.disabledReason === null;
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
    const consumePageBack = React.useCallback(() => locationOwner.consumeBack(), [locationOwner]);
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

    const binding = React.useMemo<BoundPluginSurfaceBinding>(() => ({
        ...(openSurface ? { openSurface } : {}),
        // Only a live page has a location to replace. Elsewhere the method is
        // not installed, so the mount truthfully does not advertise it.
        ...(pageIsLive
            ? {
                mountedHostApiHandlers: {
                    replacePageLocation: locationOwner.handleReplaceRequest,
                },
            }
            : {}),
    }), [locationOwner, openSurface, pageIsLive]);
    const recoveryAction = React.useMemo(() => ({
        label: t('settingsPlugins.managePlugin'),
        onPress: () => { router.push(buildPluginDetailRoute('settings', props.pluginId)); },
    }), [props.pluginId, router]);

    // Addressed by the ROUTE, not by the resolved catalog entry: the launch
    // input belongs to the navigation that carried it, so it must be delivered
    // — and, when this location is not a live page, retired — from the same two
    // identity segments plus the plugin-local location the user arrived at.
    const launch = usePluginAppPageLaunch({
        pluginId: props.pluginId,
        localId: props.localId,
        subPath: props.subPath,
    });

    const headerTitle = page?.label ?? t('pluginSurfaces.appPage.title');
    const pageHeaderActions = React.useMemo(
        () => resolvePluginAppPageHeaderActions(page),
        [page],
    );
    const activePageForHeader = pageIsLive ? page : null;
    const headerOptions = React.useMemo(() => ({
        headerTitle,
        ...(activePageForHeader && openSurface && pageHeaderActions.length > 0
            ? {
                headerRight: () => (
                    <PluginAppPageHeaderActions
                        actions={pageHeaderActions}
                        page={activePageForHeader}
                        projection={projection.pluginUiProjection}
                        actionAuthority={pageHeaderActionAuthority}
                        openSurface={openSurface}
                        signal={pageHeaderActionScope.signal}
                        isCurrent={isPageHeaderActionCurrent}
                        isDaemonExecutionCurrent={pageExecution.isExecutionOriginCurrent}
                    />
                ),
            }
            : {}),
    }), [
        activePageForHeader,
        headerTitle,
        openSurface,
        pageHeaderActions,
        pageHeaderActionScope.signal,
        projection.pluginUiProjection,
        pageHeaderActionAuthority,
        isPageHeaderActionCurrent,
        pageExecution.isExecutionOriginCurrent,
    ]);

    if (props.subPath !== null && !page && (projection.phase === 'establishing' || projection.hasEstablishingMembers)) {
        return (
            <>
                <Stack.Screen options={headerOptions} />
                <View testID="plugin-app-page-establishing" style={pageContentFrameStyle}>
                    <PluginSurfaceFallback testID="plugin-app-page-loading" state="loading" />
                </View>
            </>
        );
    }

    if (props.subPath === null || !page || page.disabledReason) {
        const unavailableReasonCode = props.subPath === null
            ? 'plugin_surface_open_sub_path_invalid'
            : page?.disabledReason ?? 'plugin_app_page_unavailable';

        return (
            <>
                <Stack.Screen options={headerOptions} />
                <PluginSurfaceFallback
                    testID="plugin-app-page-unavailable"
                    reasonCode={unavailableReasonCode}
                    action={recoveryAction}
                />
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={headerOptions} />
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
            <RouteRemovalStepConsumer active={isFocused && pageIsLive} consume={consumePageBack} />
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
                <DetailsPaneSlotHost testID="plugin-app-page-details">
                <View testID="plugin-app-page-host" style={pageContentFrameStyle}>
                    <PluginSurfacePlacementHost
                        placement={page.placement}
                        pluginUiProjection={projection.pluginUiProjection}
                        machineId={projection.machineId}
                        serverId={projection.serverId}
                        platform={projection.platform}
                        binding={binding}
                        subPath={props.subPath}
                        launchInput={launch?.input}
                        mountInstanceKey={launch?.instanceKey}
                        unavailableAction={recoveryAction}
                        projectionInteractionEnabled={projection.phase === 'current'
                            && projection.interactionEnabled}
                    />
                </View>
                </DetailsPaneSlotHost>
            </PluginSurfaceFocusEligibilityProvider>
        </>
    );
}
