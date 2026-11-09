import * as React from 'react';
import { Stack as ExpoStack, useLocalSearchParams, usePathname, type Href } from 'expo-router';
import { Platform } from 'react-native';
import { useRouteNode } from 'expo-router/build/Route';
import { resolveHref } from 'expo-router/build/link/href';
import { useOptionalWorkspaceNavigation, useWorkspaceNavigationActive } from './WorkspaceNavigationContext';
import { DestinationTitlePublication, useDestinationInstanceKey } from './DestinationInstanceHost';
import { WorkspaceRouteHostingContext } from './WorkspaceRouteHostingContext';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { workspaceRouteFiles, workspaceRouteHref } from './workspaceRoutes';
import { useRootStackRouteOptions } from '@/components/navigation/root/useRootStackRouteOptions';
import { resolveRootStackRouteOptions } from '@/components/navigation/root/rootStackRouteOptions';
import { NavigationTitleChromeProvider, useNavigationChromeShowsBack, useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

const WORKSPACE_MIRROR_SCREEN_OPTIONS = { headerShown: false } as const;

/** Whether this Expo scene is only the URL mirror of a destination the workspace hosts and renders itself. */
export function useExpoSceneMirrorsWorkspace(): boolean {
    const hosted = useDestinationInstanceKey() !== null;
    return useWorkspaceNavigationActive() && !hosted;
}

/** The Expo entry is only the URL sink when the workspace hosts its body. */
export function WorkspaceRouteEntry(props: Readonly<{ Body: React.ComponentType; mirror?: React.ReactNode; loadingFallback?: React.ReactNode }>) {
    const workspace = useOptionalWorkspaceNavigation();
    const hosted = useDestinationInstanceKey() !== null;
    const mirrorsWorkspace = useExpoSceneMirrorsWorkspace();
    const pathname = usePathname();
    const params = useLocalSearchParams();
    const ownsHref = React.useContext(WorkspaceRouteHostingContext);
    // Expo may commit this scene before its browser-history mirror. Consult the
    // workspace owner's route admission, not its preceding active-URL projection.
    const ownsRoute = ownsHref ? ownsHref(workspaceRouteHref(pathname, params)) : workspace?.ownsRoute;
    if (!hosted && ownsRoute && !workspace?.active) {
        // A temporary Expo body would lose edits when hydration admits the retained host.
        // Layout mirrors must stay mounted: Expo still owns their URL serialization.
        return <>{props.mirror ?? props.loadingFallback ?? <PaneLoadingFallback testID="workspace-route-hydrating" />}</>;
    }
    // Keep the mirror in its pending position: inserting title metadata before
    // it remounts nested Expo navigators and loses their parsed child route.
    // The workspace owns the visible title. Publishing each edit into Expo's hidden
    // scenes adds synchronous navigator layout updates to every title keystroke.
    if (mirrorsWorkspace) return <>{props.mirror}<ExpoStack.Screen options={WORKSPACE_MIRROR_SCREEN_OPTIONS} /></>;
    const body = !hosted && workspace && Platform.OS !== 'web'
        ? <NativeWorkspaceRouteTitle><props.Body /></NativeWorkspaceRouteTitle> : <props.Body />;
    return hosted ? body : <ExpoWorkspaceRouteFocus>{body}</ExpoWorkspaceRouteFocus>;
}

/** A real Expo scene owns focus when no retained workspace destination hosts it. */
function ExpoWorkspaceRouteFocus(props: React.PropsWithChildren) {
    const focused = useOptionalScreenIsFocused();
    return <PluginSurfaceFocusEligibilityProvider active={focused} currentUiContextActive={focused}>
        {props.children}
    </PluginSurfaceFocusEligibilityProvider>;
}

/** Expo's local module/params remain this scene's identity after the global URL moves elsewhere. */
function NativeWorkspaceRouteTitle(props: React.PropsWithChildren) {
    const workspace = useOptionalWorkspaceNavigation();
    const node = useRouteNode();
    const params = useLocalSearchParams();
    const rootOptions = useRootStackRouteOptions();
    const nativeShowsTitle = useNavigationTitleChromeShowsTitle();
    const nativeShowsBack = useNavigationChromeShowsBack();
    const routeKey = React.useMemo(() => Object.entries(workspaceRouteFiles).find(([, contextKey]) => contextKey === node?.contextKey)?.[0], [node?.contextKey]);
    const headerShown = resolveRootStackRouteOptions(rootOptions, node?.contextKey)?.headerShown !== false;
    // The registered Expo module inventory validates this SDK route pattern;
    // generated Href literals cannot represent the inventory's dynamic keys.
    const href = routeKey !== undefined ? resolveHref({ pathname: `/${routeKey}`, params } as Href) : null;
    const destination = href ? workspace?.findOpenHref?.(href) : null;
    const tab = destination ? workspace?.state.tabs[destination.tabId] : null;
    // Keep this nonvisual boundary mounted before/after phone readiness; only
    // its publication identity changes, never the native editable body.
    return <NavigationTitleChromeProvider showsTitle={nativeShowsTitle && headerShown} showsBack={nativeShowsBack && headerShown}>
        <DestinationTitlePublication instance={tab ? { tabId: tab.id, ref: tab.target } : null}>{props.children}</DestinationTitlePublication>
    </NavigationTitleChromeProvider>;
}
