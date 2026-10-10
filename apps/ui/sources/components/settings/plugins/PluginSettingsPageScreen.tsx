import * as React from 'react';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { Platform } from 'react-native';
import { Stack, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { createPluginAppPageLocationOwner } from '@/components/appShell/plugins/pluginAppPageLocation';
import { PluginSettingsPageHost } from '@/components/plugins/surfaces';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { useNativeBackLayerBackHandler } from '@/components/ui/overlays/NativeBackLayerBoundary';
import { RouteRemovalStepConsumer } from '@/utils/navigation/RouteRemovalStepConsumer';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { MachineAdministrationContextBar } from '@/components/settings/machines/MachineAdministrationContextBar';
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
    // One administration-target owner for every plugin Settings surface. A
    // deep-linked page addresses the same machine the plugin home and detail
    // screens administer, through the same currentness fence, and the selector
    // below names it so the reader can see which machine they are editing.
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
        return (
            <>
                <Stack.Screen options={{}} />
                <PluginSurfaceFallback testID="plugin-settings-page-loading" state="loading" />
            </>
        );
    }

    if (subPath === null) {
        // An illegal location is not the page root: fail closed at this same
        // unavailable route instead of silently opening the page root.
        return (
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
        return <PluginSurfaceFallback testID="plugin-settings-page-unavailable" action={recoveryAction} />;
    }

    if (destination.page.availability.state !== 'available') {
        return (
            <>
                <Stack.Screen options={{ title: destination.title }} />
                <PluginSurfaceFallback
                    testID="plugin-settings-page-unavailable"
                    reasonCode={destination.page.availability.reason}
                    action={recoveryAction}
                />
            </>
        );
    }

    return (
        <>
            <Stack.Screen options={{ title: destination.title }} />
            {/*
              * The administration target is a different fact from the plugin's
              * execution origin, and a deep link arrives with neither on
              * screen. Name the machine this page's fields, secrets and
              * lifecycle operations address before the fields themselves.
              */}
            <MachineAdministrationContextBar
                label={t('settingsPlugins.administrationMachineTitle')}
                selection={administration.selection}
                testIDPrefix="settings.plugins.page.administration.target"
            />
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
            </PluginSurfaceFocusEligibilityProvider>
        </>
    );
});
