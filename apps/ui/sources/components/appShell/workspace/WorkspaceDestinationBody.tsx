import * as React from 'react';

import type { DestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { loadWorkspaceRouteLayout, workspaceRouteBodies } from './workspaceRouteBodies';
import { matchWorkspaceDestinationRoute, workspaceRouteFiles } from './workspaceRoutes';
import { workspaceSettingsLayoutKeys } from './workspaceRouteContext';
import { WorkspaceRouteOutlet } from './WorkspaceRouteOutlet';

const bodies = Object.fromEntries(Object.entries(workspaceRouteBodies).map(([routeKey, load]) => (
    [routeKey, React.lazy(load)]
)));
// Stable component identities keep common layouts/providers mounted when their selected leaf changes.
const layouts = new Map<string, React.LazyExoticComponent<React.ComponentType>>();
function hostedLayout(key: string) {
    let Layout = layouts.get(key);
    if (!Layout) {
        Layout = React.lazy(() => loadWorkspaceRouteLayout(key));
        layouts.set(key, Layout);
    }
    return Layout;
}
const PluginAppPageScreen = React.lazy(() => import('@/components/appShell/plugins/PluginAppPageScreen')
    .then((module) => ({ default: module.PluginAppPageScreen })));

/** Renders the catalog-admitted identity; the Expo entrypoint is only its URL sink. */
export function WorkspaceDestinationBody(props: Readonly<{
    target: DestinationRef;
    pathname: string;
    renderSession: (target: DestinationRef) => React.ReactNode;
    renderSessionDetails: (target: DestinationRef) => React.ReactNode;
}>): React.ReactNode {
    if (props.target.kind === 'session') return props.renderSession(props.target);
    if (props.target.kind === 'sessionDetails') return props.renderSessionDetails(props.target);
    const match = matchWorkspaceDestinationRoute(props.pathname);
    const Body = match ? bodies[match.routeKey] : undefined;
    if (props.target.params.pluginId && props.target.params.localId && props.pathname.startsWith('/plugins/')) {
        return <React.Suspense fallback={<SurfaceStateCard kind="loading" title={t('common.loading')} />}>
            <PluginAppPageScreen pluginId={props.target.params.pluginId}
                localId={props.target.params.localId} subPath={props.target.params.subPath ?? ''} />
        </React.Suspense>;
    }
    if (!Body) return <SurfaceStateCard kind="unavailable" title={t('common.unavailable')} />;
    let content: React.ReactNode = <Body />;
    const contextKey = match ? workspaceRouteFiles[match.routeKey] : undefined;
    for (const key of [...(contextKey ? workspaceSettingsLayoutKeys(contextKey) : [])].reverse()) {
        const Layout = hostedLayout(key);
        content = <WorkspaceRouteOutlet.Provider key={key} value={content}><Layout /></WorkspaceRouteOutlet.Provider>;
    }
    return <React.Suspense fallback={<SurfaceStateCard kind="loading" title={t('common.loading')} />}>
        {content}
    </React.Suspense>;
}
