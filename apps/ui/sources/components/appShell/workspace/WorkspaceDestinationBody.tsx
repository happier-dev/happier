import * as React from 'react';
import { retryableLazy } from '@/components/ui/performance/retryableLazy';

import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { usePageSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { t } from '@/text';
import { loadWorkspaceRouteLayout, workspaceRouteBodies } from './workspaceRouteBodies';
import { matchWorkspaceDestinationRoute, workspaceMachinePageRouteKey, workspacePluginAppPageRouteKey, workspaceRouteFiles } from './workspaceRoutes';
import { MachinesDoorProvider, resolveMachinesDoor } from '@/components/machines/page/machinesDoor';
import { useAppShellLocation } from '@/components/navigation/shell/appRail/useAppShellLocation';
import { workspaceSettingsLayoutKeys } from './workspaceRouteContext';
import { WorkspaceRouteOutlet } from './WorkspaceRouteOutlet';
import { DestinationBodyLoading } from './DestinationBodyLoading';
import { HomeHubLoading } from '@/components/hub/HomeHubLoading';
import { useMarkLaunchDestinationBodyMounted } from '@/boot/launchCurtain';
import { useDestinationFocus } from './destinationInstanceContext';
import { PluginAppPageLoadingFrame } from '@/components/plugins/shared/PluginPageIdentityHeader';
import { pluginAppPageRouteSelectsEntry, readPluginAppPageRouteView } from '@/components/plugins/pages/pluginPageRoute';

// Routes that share one editor loader also share its lazy identity: promotion
// after Save must not suspend an already mounted editor on another route chunk.
const lazyBodies = new Map<() => Promise<{ default: React.ComponentType }>, React.ComponentType>();
const bodies = Object.fromEntries(Object.entries(workspaceRouteBodies).map(([routeKey, load]) => {
    let Body = lazyBodies.get(load);
    if (!Body) {
        Body = retryableLazy(load);
        lazyBodies.set(load, Body);
    }
    return [routeKey, Body];
}));
// Stable component identities keep common layouts/providers mounted when their selected leaf changes.
const layouts = new Map<string, React.ComponentType>();
function hostedLayout(key: string) {
    let Layout = layouts.get(key);
    if (!Layout) {
        Layout = retryableLazy(() => loadWorkspaceRouteLayout(key));
        layouts.set(key, Layout);
    }
    return Layout;
}
/** Home's route (`/`): where a reload lands, so while its page loads it holds Home's own shape. */
const HOME_ROUTE_KEY = '';

const PluginAppPageScreen = retryableLazy(async () => ({
    default: (await import('@/components/appShell/plugins/PluginAppPageScreen')).PluginAppPageScreen,
}));

/** A destination with no page is a page-level state: it takes the page step (and its failed scene). */
function DestinationUnavailable(): React.ReactElement {
    return <SurfaceStateCard kind="unavailable" size={usePageSurfaceStateSize()} title={t('common.unavailable')} />;
}

function LaunchDestinationBody({ children, pathname }: Readonly<{ children: React.ReactNode; pathname: string }>): React.ReactNode {
    const focused = useDestinationFocus();
    useMarkLaunchDestinationBodyMounted(focused, pathname);
    return children;
}

/** Renders the catalog-admitted identity; the Expo entrypoint is only its URL sink. */
export const WorkspaceDestinationBody = React.memo(function WorkspaceDestinationBody(props: Readonly<{
    target: DestinationRef;
    pathname: string;
    renderSession: (target: DestinationRef) => React.ReactNode;
    renderSessionDetails: (target: DestinationRef) => React.ReactNode;
}>): React.ReactNode {
    if (props.target.kind === 'session') return <LaunchDestinationBody pathname={props.pathname}>{props.renderSession(props.target)}</LaunchDestinationBody>;
    if (props.target.kind === 'sessionDetails') return <LaunchDestinationBody pathname={props.pathname}>{props.renderSessionDetails(props.target)}</LaunchDestinationBody>;
    const match = matchWorkspaceDestinationRoute(props.pathname);
    const Body = match ? bodies[match.routeKey] : undefined;
    if (match && workspacePluginAppPageRouteKey(match.routeKey) && props.target.params.pluginId && props.target.params.localId) {
        const { pluginId, localId, subPath = '' } = props.target.params;
        return <React.Suspense fallback={<PluginAppPageLoadingFrame testID="plugin-app-page-module-loading"
            entryDetail={pluginAppPageRouteSelectsEntry(pluginId, subPath)} />}>
            <LaunchDestinationBody pathname={props.pathname}>
                <PluginAppPageScreen pluginId={pluginId}
                    localId={localId} subPath={subPath}
                    view={readPluginAppPageRouteView(props.target.params.view)} />
            </LaunchDestinationBody>
        </React.Suspense>;
    }
    if (!Body) return <LaunchDestinationBody pathname={props.pathname}><DestinationUnavailable /></LaunchDestinationBody>;
    let content: React.ReactNode = <Body />;
    const machineKey = match ? workspaceMachinePageRouteKey(match.routeKey) : null;
    // Keep the page below the same providers when only its door changes. The collection
    // draws its rail only in Settings; the app shell owns the rail door's column.
    const contextKey = match ? workspaceRouteFiles[machineKey ? `settings/${machineKey}` : match.routeKey] : undefined;
    const layoutKeys = contextKey ? workspaceSettingsLayoutKeys(contextKey) : [];
    for (const key of [...layoutKeys].reverse()) {
        const Layout = hostedLayout(key);
        content = <WorkspaceRouteOutlet.Provider key={key} value={content}><Layout /></WorkspaceRouteOutlet.Provider>;
    }
    // Home draws the same Home-shaped placeholder until its own model answers, so the two waits read as one.
    if (match?.routeKey === HOME_ROUTE_KEY) {
        // Home can mount its visible panel after the route commits. Its presentation owner takes the curtain.
        return <React.Suspense fallback={<HomeHubLoading testID="home-hub.loading" />}>{content}</React.Suspense>;
    }
    return <React.Suspense fallback={<DestinationBodyLoading />}>
        <LaunchDestinationBody pathname={props.pathname}>{layoutKeys.includes('./(app)/settings/machines/_layout.tsx')
            ? <MachinesDoorFromShell pathname={props.pathname}>{content}</MachinesDoorFromShell> : content}</LaunchDestinationBody>
    </React.Suspense>;
});

/** A Machines page's door follows the shell column beside it; only machine pages subscribe to it. */
function MachinesDoorFromShell(props: Readonly<{ pathname: string; children: React.ReactNode }>) {
    const { column } = useAppShellLocation().location;
    const door = resolveMachinesDoor({ pathname: props.pathname, shellColumnId: column.kind === 'builtin' ? column.id : null });
    return <MachinesDoorProvider door={door}>{props.children}</MachinesDoorProvider>;
}
