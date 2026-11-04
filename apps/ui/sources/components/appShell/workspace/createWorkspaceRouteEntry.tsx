import * as React from 'react';
import { Stack as ExpoStack, useLocalSearchParams, usePathname, type Href } from 'expo-router';
import { Platform } from 'react-native';
import { useRouteNode } from 'expo-router/build/Route';
import { resolveHref } from 'expo-router/build/link/href';
import { useOptionalWorkspaceNavigation } from './WorkspaceNavigationContext';
import { DestinationTitlePublication, useDestinationInstanceKey } from './DestinationInstanceHost';
import { WorkspaceRouteHostingContext } from './WorkspaceRouteHostingContext';
import { PaneLoadingFallback } from '@/components/ui/panels/PaneLoadingFallback';
import { useWorkspaceFocusedDestinationTitle } from './WorkspaceWindowTitle';
import { workspaceRouteFiles, workspaceRouteHref } from './workspaceRoutes';
import { useRootStackRouteOptions } from '@/components/navigation/root/useRootStackRouteOptions';
import { resolveRootStackRouteOptions } from '@/components/navigation/root/rootStackRouteOptions';
import { NavigationTitleChromeProvider, useNavigationChromeShowsBack, useNavigationTitleChromeShowsTitle } from '@/components/ui/layout/navigationTitleChrome';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

/** The Expo entry is only the URL sink when the workspace hosts its body. */
export function WorkspaceRouteEntry(props: Readonly<{ Body: React.ComponentType; mirror?: React.ReactNode; loadingFallback?: React.ReactNode }>) {
    const workspace = useOptionalWorkspaceNavigation();
    const hosted = useDestinationInstanceKey() !== null;
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
    if (workspace?.active === true && !hosted) return <>{props.mirror}<WorkspaceRouteTitle /></>;
    return !hosted && workspace && Platform.OS !== 'web'
        ? <NativeWorkspaceRouteTitle><props.Body /></NativeWorkspaceRouteTitle> : <props.Body />;
}

/** Expo's local module/params remain this scene's identity after the global URL moves elsewhere. */
function NativeWorkspaceRouteTitle(props: React.PropsWithChildren) {
    const focused = useOptionalScreenIsFocused();
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
    return <PluginSurfaceFocusEligibilityProvider active={focused}>
        <NavigationTitleChromeProvider showsTitle={nativeShowsTitle && headerShown} showsBack={nativeShowsBack && headerShown}>
            <DestinationTitlePublication instance={tab ? { tabId: tab.id, ref: tab.target } : null}>{props.children}</DestinationTitlePublication>
        </NavigationTitleChromeProvider>
    </PluginSurfaceFocusEligibilityProvider>;
}

/** Expo retains navigation metadata while its route is only the workspace's URL mirror. */
function WorkspaceRouteTitle() {
    const title = useWorkspaceFocusedDestinationTitle() ?? '';
    const options = React.useMemo(() => ({ title, headerShown: false }), [title]);
    return <ExpoStack.Screen options={options} />;
}
