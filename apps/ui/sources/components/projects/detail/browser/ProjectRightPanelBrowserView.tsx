import * as React from 'react';

import { BrowserScopedWorkspace } from '@/components/browser/surfaces/BrowserScopedWorkspace';
import {
    resolveBrowserSurfacePlatform,
    useBrowserSurfaceHostProps,
} from '@/components/browser/surfaces/useBrowserSurfaceHostProps';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

/**
 * Project-cockpit mobile browser surface (project-mobile-only post-D1). Mounts a scoped instance of
 * the SAME details-workspace tab engine as the session cockpit and desktop (D2-revised) so browser
 * tabs reorder/close/activate identically everywhere. The `scopeId` is threaded from the cockpit.
 */
export function ProjectRightPanelBrowserView(props: Readonly<{
    workspaceRefId: string;
    scopeId?: string;
    /** An enclosing Project panel supplies its one admitted projection. */
    pluginProjection?: PluginUiProjectionCurrentness;
}>): React.ReactElement {
    const workspaceRef = useWorkspaceRefById(props.workspaceRefId);
    const scopeId = props.scopeId ?? `project:${props.workspaceRefId}:mobile-browser`;
    const scopedPluginProjection = useScopedPluginUiProjection({
        machineId: workspaceRef?.machineId ?? null,
        serverId: workspaceRef?.serverId ?? null,
        enabled: props.pluginProjection === undefined,
    });
    const pluginProjection = props.pluginProjection ?? scopedPluginProjection;
    // Assemble the live workspace-ranked launchpad feed so the project mobile new-tab page shows
    // running services + recents, not only URL entry.
    const hostProps = useBrowserSurfaceHostProps({
        scope: 'workspaceDetails',
        workspaceRefId: props.workspaceRefId,
        machineId: workspaceRef?.machineId ?? null,
        serverId: workspaceRef?.serverId ?? null,
    });

    return (
        <BrowserScopedWorkspace
            scopeId={scopeId}
            scope={{
                kind: 'session',
                sessionId: props.workspaceRefId,
                workspaceRefId: props.workspaceRefId,
                serverId: workspaceRef?.serverId ?? null,
                machineId: workspaceRef?.machineId ?? null,
            }}
            openScope="sessionMobile"
            platform={resolveBrowserSurfacePlatform()}
            localServicePreviewState={hostProps.localServicePreviewState}
            localServicePreviewServerId={hostProps.localServicePreviewServerId}
            launchpadRows={hostProps.launchpadRows}
            launchpadRefreshStatus={hostProps.launchpadRefreshStatus}
            launchpadRefreshError={hostProps.launchpadRefreshError}
            pluginProjection={pluginProjection}
            pluginBrowserActionSessionId={null}
            testID="project-rightpanel-browser"
        />
    );
}
