import * as React from 'react';
import { usePathname, useRouter } from 'expo-router';
import type { PluginUiDestinationReferenceV1, PluginUiInstanceKeyV1 } from '@happier-dev/protocol/plugins/ui';

import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { useDetailsPaneAvailable } from '@/components/appShell/panes/details/detailsPaneAvailability';
import type { SelectedPaneDestinationV1 } from '@/components/appShell/panes/model/selectedPaneDestination';
import { selectedPaneDestinationTabKey } from '@/components/appShell/panes/model/selectedPaneDestination';
import { useOpenPaneDestinationWindow } from '@/components/appShell/panes/useOpenPaneDestinationWindow';
import type { PluginSurfaceOpenOutcome } from '@/components/plugins/surfaces/openPluginSurface';
import {
    stagePluginSurfacePaneLaunch,
    usePluginSurfacePaneLaunchScope,
    type PluginSurfaceDestinationContainerHandler,
    type PluginSurfacePaneLaunchStore,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import {
    buildPluginPanelsRoute,
    PLUGIN_PANELS_ROUTE,
} from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * The one AppPane scope of the App's own pages (Plugins, plugin pages): their right sidebar lists the
 * App panels. Pane state lives in the app-lifetime `AppPaneProvider` reducer, so a panel can be
 * selected here before the page that shows it is entered.
 */
export const APP_PANE_SCOPE_ID = 'app';

export type OpenAppRightSidebarTabInput = Readonly<{
    destination: PluginUiDestinationReferenceV1;
    /** A multiple-instance panel's bounded instance key, when its opener supplied one. */
    instanceKey?: PluginUiInstanceKeyV1;
    /** The pane scope of the page on screen, or `null` when that page has no right sidebar. */
    activeScopeId: string | null;
    /** Side panes stand beside the page here (not a phone, panes not turned off). */
    sidePanesAvailable: boolean;
    pathname: string;
    select: (scopeId: string, destination: SelectedPaneDestinationV1) => void;
    navigate: (href: string) => void;
}>;

/**
 * Where an App panel (`rightSidebarTab × app`) opens: in the right sidebar of the page on screen —
 * a Session's, a Project's or the App's, which all list App panels — without navigating. On a phone,
 * or on a page with no right sidebar, it is its own page under Plugins.
 */
export function openAppRightSidebarTab(input: OpenAppRightSidebarTabInput): void {
    const selected: SelectedPaneDestinationV1 = {
        kind: 'plugin',
        destination: input.destination,
        ...(input.instanceKey === undefined ? {} : { instanceKey: input.instanceKey }),
    };
    if (input.sidePanesAvailable && input.activeScopeId !== null) {
        input.select(input.activeScopeId, selected);
        return;
    }
    input.select(APP_PANE_SCOPE_ID, selected);
    if (input.pathname.replace(/\/+$/, '') !== PLUGIN_PANELS_ROUTE) {
        input.navigate(buildPluginPanelsRoute(input.destination));
    }
}

/** The live bindings of {@link openAppRightSidebarTab}: pane state, the device and the router. */
export function useOpenAppRightSidebarTab(): (destination: PluginUiDestinationReferenceV1) => void {
    const router = useRouter();
    const pathname = usePathname();
    const pane = useOptionalAppPaneContext(value => ({
        dispatch: value.dispatch,
        activeScopeId: value.state.activeScopeId,
        getReadState: value.getReadState,
    }));
    const openWindow = useOpenPaneDestinationWindow();
    const sidePanesAvailable = useDetailsPaneAvailable();
    // Read at press time, so the callback stays stable across navigation and pane changes.
    const latest = React.useRef({ router, pathname, pane, sidePanesAvailable });
    latest.current = { router, pathname, pane, sidePanesAvailable };
    return React.useCallback((destination) => {
        const facts = latest.current;
        const dispatch = facts.pane?.dispatch;
        if (!dispatch) return;
        const scopeId = facts.pane?.activeScopeId;
        if (scopeId && facts.pane?.getReadState().scopes[scopeId]?.right.presentation) {
            fireAndForget(openWindow(scopeId, selectedPaneDestinationTabKey('right'), () => {
                dispatch({ type: 'selectRightDestination', scopeId, destination: { kind: 'plugin', destination } });
            }), { tag: 'openAppRightSidebarTab' });
            return;
        }
        openAppRightSidebarTab({
            destination,
            activeScopeId: facts.pane?.activeScopeId ?? null,
            sidePanesAvailable: facts.sidePanesAvailable,
            pathname: facts.pathname,
            select: (scopeId, selected) => dispatch({ type: 'selectRightDestination', scopeId, destination: selected }),
            navigate: (href) => {
                const result = runGuardedNavigation(() => facts.router.push(href as never));
                if (result !== true) fireAndForget(result, { tag: 'openAppRightSidebarTab' });
            },
        });
    }, [openWindow]);
}

/**
 * The app-target `rightSidebarTab` navigation owner (a plugin's `openSurface` to an App panel). It is
 * registered at app lifetime with the app-target binding, so a plugin's first open works before any
 * particular page is mounted. It stages the admitted launch input into the shared pane handoff scope,
 * then opens the panel where {@link openAppRightSidebarTab} says.
 */
export function createAppScopeRightSidebarDestinationHandler(input: Readonly<{
    /** The app-lifetime pane handoff scope; absent means no bounded carrier. */
    store: PluginSurfacePaneLaunchStore | null;
    /** Opens the panel; absent outside an AppPane host. */
    open: ((destination: PluginUiDestinationReferenceV1, instanceKey?: PluginUiInstanceKeyV1) => void | PluginSurfaceOpenOutcome | Promise<PluginSurfaceOpenOutcome>) | null;
}>): PluginSurfaceDestinationContainerHandler {
    return (resolution) => {
        if (resolution.placement.binding.container !== 'rightSidebarTab' || !input.open) {
            return {
                ok: false,
                code: 'unavailable',
                reason: 'plugin_surface_open_destination_owner_unavailable',
            };
        }
        // Selection is durable pane state while launch input is not. Refuse the open rather than
        // selecting a destination that would then render without the argument its caller supplied.
        if (!input.store || !stagePluginSurfacePaneLaunch({ store: input.store, resolution })) {
            return {
                ok: false,
                code: 'unavailable',
                reason: 'plugin_surface_open_origin_unavailable',
            };
        }
        return input.open(resolution.placement.binding.destination, resolution.request.instanceKey) ?? { ok: true };
    };
}

/** The sole React adapter binding that owner to the live pane state, device and router. */
export function useAppScopeRightSidebarDestinationHandler(window = false): PluginSurfaceDestinationContainerHandler {
    const router = useRouter();
    const pathname = usePathname();
    const paneContext = useOptionalAppPaneContext(value => ({
        dispatch: value.dispatch,
        activeScopeId: value.state.activeScopeId,
        getReadState: value.getReadState,
    }));
    const openWindow = useOpenPaneDestinationWindow();
    const sidePanesAvailable = useDetailsPaneAvailable();
    const store = usePluginSurfacePaneLaunchScope()?.store ?? null;
    const dispatch = paneContext?.dispatch ?? null;
    const activeScopeId = paneContext?.activeScopeId ?? null;
    const open = React.useMemo(() => (dispatch
        ? (destination: PluginUiDestinationReferenceV1, instanceKey?: PluginUiInstanceKeyV1) => {
            const scopeId = paneContext?.getReadState().activeScopeId;
            if (window || (scopeId && paneContext?.getReadState().scopes[scopeId]?.right.presentation)) {
                if (!scopeId) return { ok: false as const, code: 'unavailable' as const, reason: 'desktop_window_pane_owner_unavailable' };
                return openWindow(scopeId, selectedPaneDestinationTabKey('right'), () => dispatch({
                    type: 'selectRightDestination', scopeId, destination: { kind: 'plugin', destination,
                        ...(instanceKey === undefined ? {} : { instanceKey }) },
                }));
            }
            return openAppRightSidebarTab({
            destination,
            ...(instanceKey === undefined ? {} : { instanceKey }),
            activeScopeId,
            sidePanesAvailable,
            pathname,
            select: (scopeId, selected) => dispatch({ type: 'selectRightDestination', scopeId, destination: selected }),
            navigate: (href) => { router.push(href as Parameters<typeof router.push>[0]); },
            });
        }
        : null
    ), [activeScopeId, dispatch, openWindow, paneContext, pathname, router, sidePanesAvailable, window]);
    return React.useMemo(() => createAppScopeRightSidebarDestinationHandler({ store, open }), [open, store]);
}
