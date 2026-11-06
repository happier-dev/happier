import * as React from 'react';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { Platform } from 'react-native';
import { Stack, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { createPluginAppPageLocationOwner } from '@/components/appShell/plugins/pluginAppPageLocation';
import { PluginSettingsPageHost } from '@/components/plugins/surfaces';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { PluginSurfaceProjectionDemand } from '@/components/plugins/surfaces/PluginSurfaceProjectionDemand';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';
import { RouteRemovalStepConsumer } from '@/utils/navigation/RouteRemovalStepConsumer';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { PluginPageBackStepProvider } from '@/components/plugins/shared/PluginPageBackStep';
import { PluginPageIdentityHeaderProvider } from '@/components/plugins/shared/PluginPageIdentityHeader';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PluginMachineExecutionOriginSelectorView } from '@/components/settings/machines/PluginMachineExecutionOriginSelector';
import { useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { isPluginSurfaceMachineBound, usePluginSurfaceExecutionOrigin } from '@/components/plugins/surfaces/pluginSurfaceExecutionOrigin';
import { PageNavigationContextActionsProvider } from '@/components/ui/layout/NavigationHeaderActions';
import { PageFrame } from '@/components/ui/layout/PageFrame';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import {
    useScopedPluginSettingsDaemonTargetBinding,
} from '@/sync/domains/machines/administration/scopedPluginSettingsTarget';
import {
    buildPluginSettingsPageRoutePath,
    resolveAdmittedPluginSettingsPage,
    type ResolvedPluginSettingsPageDestination,
} from '@/components/settings/catalog/runtime/pluginSettingsPageCatalog';
import { getPreferredLanguage, t } from '@/text';
import { buildPluginDetailRoute } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';

export const PluginSettingsPageScreen = React.memo(function PluginSettingsPageScreen(props: Readonly<{
    pluginId: string | null;
    pageId: string | null;
    /**
     * The plugin-local location this route has settled on: `''` at the page
     * root and `null` for an illegal location. `undefined` is the pre-location
     * spelling of this screen and means the page root, like the route reader.
     */
    subPath?: string | null;
}>): React.ReactElement {
    const isFocused = useIsFocused();
    const router = useRouter();
    const appShell = useAppShellPluginUiProjection();
    // Settings writes retain the canonical administration target independently
    // of the page's execution origin; Account fields do not imply machine administration.
    const administration = useScopedPluginSettingsDaemonTargetBinding(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins,
    );
    const daemonSettingsTarget = administration.target;
    const isDaemonSettingsTargetCurrent = administration.isTargetCurrent;
    const locale = getPreferredLanguage();
    const destination = React.useMemo<ResolvedPluginSettingsPageDestination | null>(() => (
        props.pluginId && props.pageId
            ? resolveAdmittedPluginSettingsPage({
                projection: appShell.pluginUiProjection,
                pluginId: props.pluginId,
                pageId: props.pageId,
                locale,
            })
            : null
    ), [appShell.pluginUiProjection, locale, props.pageId, props.pluginId]);
    const needsMachineExecution = destination !== null && isPluginSurfaceMachineBound({
        pluginId: destination.page.pluginId, surface: destination.page, projection: appShell.pluginUiProjection,
    });
    const pageExecution = usePluginSurfaceExecutionOrigin({
        pluginId: props.pluginId ?? '',
        projection: appShell.pluginUiProjection,
        entry: destination?.page,
        enabled: needsMachineExecution,
    });
    const phoneTitleChrome = useNavigationTitleChromeShowsTitle();
    const executionChip = React.useMemo(() => needsMachineExecution ? <PluginMachineExecutionOriginSelectorView
        selection={pageExecution.selection} presentation="chip" compact={phoneTitleChrome}
        groupTitle={t('settingsPlugins.executionOriginTitle')} testIDPrefix="plugin-page-execution" /> : null,
    [needsMachineExecution, pageExecution.selection, phoneTitleChrome]);
    // The page's name before its destination resolves is still its plugin's, never another page's.
    const identityTitle = destination?.title
        ?? (props.pluginId ? appShell.pluginUiProjection?.installedPackagesById[props.pluginId]?.displayName : undefined)
        ?? null;
    const headerOptions = React.useMemo(() => ({ title: identityTitle ?? undefined, headerTitle: identityTitle ?? t('pluginSurfaces.appPage.title'),
        headerRight: () => executionChip }), [identityTitle, executionChip]);
    const renderPage = (body: React.ReactNode) => <PageNavigationContextActionsProvider actions={executionChip}>
        {props.pluginId && props.pageId && props.subPath !== null ? <PluginSurfaceProjectionDemand
            pluginId={props.pluginId} accountScope={appShell.accountLifetime?.scope ?? null}
            enabled={isFocused && (needsMachineExecution || !destination && (appShell.phase === 'establishing' || appShell.hasEstablishingMembers))} /> : null}
        <Stack.Screen options={headerOptions} />{body}
    </PageNavigationContextActionsProvider>;
    // A page that has loaded nothing keeps its identity above its state, in the page column, so the
    // Settings Back sits on its header instead of floating over the state (`PluginSurfaceFallback`).
    const renderFallbackPage = (fallback: React.ReactNode) => renderPage(props.pluginId && identityTitle
        ? <PluginPageIdentityHeaderProvider pluginId={props.pluginId} title={identityTitle}>{fallback}</PluginPageIdentityHeaderProvider>
        : <PageFrame content="column" style={{ flex: 1 }}>{fallback}</PageFrame>);
    const recoveryAction = React.useMemo(() => {
        const pluginId = props.pluginId;
        return pluginId
            ? {
                label: t('settingsPlugins.managePlugin'),
                onPress: () => { router.push(buildPluginDetailRoute('settings', pluginId)); },
            }
            : undefined;
    }, [props.pluginId, router]);

    // The route's one page location and page-internal Back step, through the
    // SAME owner the App Page route uses (`NAV-2`/`NAV-3`): same fact, same
    // rules, no second decision-maker. The live location and mount currentness
    // are read through refs so the owner's identity is the ROUTE's, not a value
    // that changes on every navigation — rebuilding it per location would rearm
    // a fresh participant mid-interaction and lose the declared step.
    const subPath = props.subPath === undefined ? '' : props.subPath;
    const subPathRef = React.useRef<string | null>(subPath);
    subPathRef.current = subPath;
    const screenIsMountedRef = React.useRef(true);
    React.useEffect(() => {
        screenIsMountedRef.current = true;
        return () => { screenIsMountedRef.current = false; };
    }, []);
    const locationOwner = React.useMemo(() => createPluginAppPageLocationOwner({
        currentSubPath: () => subPathRef.current,
        // Reached only while a live location exists; the route reader hands
        // back `null` exactly when the identity segments did not parse.
        routePathFor: (pageSubPath) => buildPluginSettingsPageRoutePath({
            pluginId: props.pluginId ?? '',
            pageId: props.pageId ?? '',
            subPath: pageSubPath,
        }),
        replaceLocation: (route) => {
            router.replace(route as Parameters<typeof router.replace>[0]);
        },
        isCurrent: () => screenIsMountedRef.current,
    }), [props.pageId, props.pluginId, router]);
    React.useEffect(() => () => locationOwner.dispose(), [locationOwner]);
    const pageIsLive = subPath !== null && destination !== null
        && destination.page.availability.state === 'available';
    // A foreign location or a retired renderer clears the declared step. A
    // renderer that later becomes available at the same route must not inherit
    // a Back step declared by the previous live instance.
    React.useEffect(() => {
        locationOwner.retireForeignLocationChange(pageIsLive ? subPath : null);
    }, [locationOwner, pageIsLive, subPath]);
    const consumePageBack = React.useCallback(() => locationOwner.consumeBack(), [locationOwner]);
    useNativeBackLayerBackHandler(
        Platform.OS === 'android' && isFocused && pageIsLive,
        consumePageBack,
    );
    // Escape is the desktop and web keyboard's Back, ordered by the app's one
    // Escape layer stack rather than a private key listener; yielding when the
    // page has no declared step lets lower layers answer the same press.
    useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.pane,
        enabled: isFocused && pageIsLive,
        onEscape: consumePageBack,
    });
    const appTargetBinding = usePluginSurfaceDestinationNavigationBinding();
    const binding = React.useMemo<BoundPluginSurfaceBinding>(
        () => ({
            ...(appTargetBinding ? { openSurface: appTargetBinding.openSurface } : {}),
            // Only a live page has a location to replace. Elsewhere the method
            // is not installed, so the mount truthfully does not advertise it.
            ...(pageIsLive
                ? {
                    mountedHostApiHandlers: {
                        replacePageLocation: locationOwner.handleReplaceRequest,
                    },
                }
                : {}),
        }),
        [appTargetBinding, locationOwner, pageIsLive],
    );

    if (
        props.pluginId
        && props.pageId
        && subPath !== null
        && !destination
        && (appShell.phase === 'establishing' || appShell.hasEstablishingMembers)
    ) {
        return renderFallbackPage(<PluginSurfaceFallback testID="plugin-settings-page-loading" state="loading" />);
    }

    if (subPath === null) {
        // An illegal location is not the page root: fail closed at this same
        // unavailable route instead of silently opening the page root.
        return renderFallbackPage(
            <PluginSurfaceFallback
                testID="plugin-settings-page-unavailable"
                reasonCode="plugin_surface_open_sub_path_invalid"
                action={recoveryAction}
            />
        );
    }

    if (!destination) {
        // A removed, malformed, or stale page remains at its own
        // generic route. It is never redirected to a different plugin/page.
        return renderFallbackPage(<PluginSurfaceFallback testID="plugin-settings-page-unavailable" action={recoveryAction} />);
    }

    // The shared host evaluates policy before projecting resolving selection as
    // loading. Do not let a route-local loader swallow a real policy denial.
    if (destination.page.availability.state !== 'available' && destination.page.availability.state !== 'resolving') {
        return renderFallbackPage(
            <PluginSurfaceFallback
                testID="plugin-settings-page-unavailable"
                reasonCode={destination.page.availability.reason}
                action={recoveryAction}
            />
        );
    }

    const pageHost = (
        <PluginSettingsPageHost
            page={destination.page}
            subPath={subPath}
            pluginUiProjection={appShell.pluginUiProjection}
            machineId={appShell.machineId}
            serverId={appShell.serverId}
            daemonSettingsTarget={daemonSettingsTarget}
            perActiveServerIdentityId={administration.selectedServerIdentityId}
            isDaemonSettingsTargetCurrent={isDaemonSettingsTargetCurrent}
            settingsScopesEnabled={{ account: true, daemon: daemonSettingsTarget !== null }}
            binding={binding}
            unavailableAction={recoveryAction}
            platform={appShell.platform}
            projectionInteractionEnabled={appShell.phase === 'current'
                && appShell.interactionEnabled}
        />
    );
    return renderPage(
        <>
            {/*
              * A focused Settings route is this subtree's one semantic current
              * owner, exactly as the App Page route is for its own. Without the
              * second fact the mounted surface stays presentation-eligible but
              * permanently current-context-ineligible, so its published entity
              * and commands never reach the current-context reader or Voice.
              */}
            <PluginSurfaceFocusEligibilityProvider
                active={isFocused}
                currentUiContextActive={isFocused}
            >
                {/**
                  * The other three ways back, in one participant: a browser's
                  * Back button, an iOS header Back and an iOS edge-swipe are
                  * one fact — the route is being REMOVED — and the shared
                  * consumer spends the page's declared step before that
                  * happens. (Android hardware Back answered above; Escape in
                  * the keyboard layer stack.)
                  */}
                <RouteRemovalStepConsumer active={isFocused && pageIsLive} consume={consumePageBack} />
                <PluginPageBackStepProvider owner={locationOwner}>
                {destination.page.renderer.kind === 'declarative'
                    // A declarative page is the author's content only; like every Settings page it
                    // sits in the page column with the page gutters instead of touching the window edge.
                    // It opens with its title like every Settings page (the native header carries it on phones).
                    // Its settings sections take the configuration-page anatomy (description above the rows).
                    ? <PageFrame column="reading" style={{ flex: 1 }}>
                        {destination.title ? <PageHeader title={destination.title} /> : null}
                        <ListPresentationProvider value="page">{pageHost}</ListPresentationProvider>
                    </PageFrame>
                    // A rendered page draws its own header; when it has loaded nothing, the page keeps its identity.
                    : <PluginPageIdentityHeaderProvider pluginId={destination.page.pluginId} title={destination.title ?? t('pluginSurfaces.appPage.title')}>
                        {pageHost}
                    </PluginPageIdentityHeaderProvider>}
                </PluginPageBackStepProvider>
            </PluginSurfaceFocusEligibilityProvider>
        </>
    );
});
