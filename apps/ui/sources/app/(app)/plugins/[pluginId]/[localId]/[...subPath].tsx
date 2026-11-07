import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { PluginAppPageScreen } from '@/components/appShell/plugins/PluginAppPageScreen';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import {
    readPluginAppPageRouteView,
    readPluginPageRouteIdentity,
} from '@/components/plugins/pages/pluginPageRoute';
import { readPluginPageSubPath } from '@/components/plugins/pages/pluginPages';

export const WorkspaceRouteBody = React.memo(function PluginPageDeepRoute() {
    const params = useLocalSearchParams();
    const identity = readPluginPageRouteIdentity(params);

    return (
        <PluginAppPageScreen
            pluginId={identity.pluginId}
            localId={identity.localId}
            subPath={readPluginPageSubPath(params.subPath)}
            view={readPluginAppPageRouteView(params.view)}
        />
    );
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() {
    return <WorkspaceRouteEntry Body={WorkspaceRouteBody}
        loadingFallback={<PluginSurfaceFallback testID="plugin-app-page-hydrating" state="loading" />} />;
}
