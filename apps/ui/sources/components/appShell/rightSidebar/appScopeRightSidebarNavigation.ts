import * as React from 'react';
import { usePathname, useRouter } from 'expo-router';

import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import type { SelectedPaneDestinationV1 } from '@/components/appShell/panes/model/selectedPaneDestination';
import type { PluginSurfaceOpenOutcome } from '@/components/plugins/surfaces/openPluginSurface';
import {
    stagePluginSurfacePaneLaunch,
    usePluginSurfacePaneLaunchScope,
    type PluginSurfaceDestinationContainerHandler,
    type PluginSurfacePaneLaunchStore,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

/**
 * The one AppPane scope that owns the app-scope right sidebar's selection.
 *
 * Pane state lives in the app-lifetime `AppPaneProvider` reducer, so this scope
 * exists whether or not its route is mounted. That is what lets the navigation
 * owner below select a destination BEFORE the route is entered, instead of
 * requiring the destination's own screen to already be on screen.
 */
export const APP_RIGHT_SIDEBAR_PANE_SCOPE_ID = 'settings:plugins:panels';

/**
 * The incumbent app-scope `rightSidebarTab` navigation owner.
 *
 * `app.rightSidebarTab` is an app-target destination, so its opener has to be
 * registered with the app-target binding for the SAME reason `appPage` and
 * `settingsPage` are: a plugin's first `openSurface` happens before any
 * particular route is mounted. Registering it from the sidebar leaf made the
 * first open fail precisely because the route that would install the resolver
 * had not been entered yet.
 *
 * It owns nothing new. It stages the already-admitted launch input into the
 * shared pane handoff scope, records the selection through the canonical
 * AppPane owner, and hands the route to the incumbent router. The sidebar leaf
 * stays presentation-only.
 */
export function createAppScopeRightSidebarDestinationHandler(input: Readonly<{
    /** The app-lifetime pane handoff scope; absent means no bounded carrier. */
    store: PluginSurfacePaneLaunchStore | null;
    /** The canonical AppPane selection writer; absent outside an AppPane host. */
    selectDestination: ((destination: SelectedPaneDestinationV1) => void) | null;
    pathname: string;
    navigate: (routePath: string) => void;
}>): PluginSurfaceDestinationContainerHandler {
    return (resolution): PluginSurfaceOpenOutcome => {
        if (
            resolution.placement.binding.container !== 'rightSidebarTab'
            || !input.selectDestination
        ) {
            return {
                ok: false,
                code: 'unavailable',
                reason: 'plugin_surface_open_destination_owner_unavailable',
            };
        }
        // Selection is durable pane state while launch input is not. Refuse the
        // open rather than selecting a destination that would then render
        // without the argument its caller supplied.
        if (!input.store || !stagePluginSurfacePaneLaunch({ store: input.store, resolution })) {
            return {
                ok: false,
                code: 'unavailable',
                reason: 'plugin_surface_open_origin_unavailable',
            };
        }
        input.selectDestination({
            kind: 'plugin',
            destination: resolution.placement.binding.destination,
            ...(resolution.request.instanceKey === undefined
                ? {}
                : { instanceKey: resolution.request.instanceKey }),
        });
        // Selection already moved, so a repeat open on the mounted route is
        // idempotent and must not push a second history entry.
        if (input.pathname !== SETTINGS_ROUTES.pluginPanels) {
            input.navigate(SETTINGS_ROUTES.pluginPanels);
        }
        return { ok: true };
    };
}

/**
 * The sole React adapter binding that owner to the live router and pane state.
 *
 * It reads the AppPane context OPTIONALLY: this owner is registered at app
 * lifetime, above any particular pane host, and a shell mounted without one
 * must report the container unavailable rather than throwing during render.
 */
export function useAppScopeRightSidebarDestinationHandler(): PluginSurfaceDestinationContainerHandler {
    const router = useRouter();
    const pathname = usePathname();
    const paneContext = useOptionalAppPaneContext();
    const paneLaunchScope = usePluginSurfacePaneLaunchScope();
    const store = paneLaunchScope?.store ?? null;
    const paneDispatch = paneContext?.dispatch ?? null;
    const selectDestination = React.useMemo(() => (paneDispatch
        ? (destination: SelectedPaneDestinationV1) => paneDispatch({
            type: 'selectRightDestination',
            scopeId: APP_RIGHT_SIDEBAR_PANE_SCOPE_ID,
            destination,
        })
        : null
    ), [paneDispatch]);
    return React.useMemo(() => createAppScopeRightSidebarDestinationHandler({
        store,
        selectDestination,
        pathname,
        navigate: (routePath) => {
            router.push(routePath as Parameters<typeof router.push>[0]);
        },
    }), [pathname, router, selectDestination, store]);
}
