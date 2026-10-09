import * as React from 'react';

import { BrowserScopedWorkspace } from '@/components/browser/surfaces/BrowserScopedWorkspace';
import {
    resolveBrowserSurfacePlatform,
    useBrowserSurfaceHostProps,
} from '@/components/browser/surfaces/useBrowserSurfaceHostProps';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useWorkspaceRefById } from '@/components/projects/detail/useWorkspaceRefById';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

/**
 * Project companion Browser on desktop and mobile. Mounts a scoped instance of
 * the SAME details-workspace tab engine as the session cockpit and desktop (D2-revised) so browser
 * tabs reorder/close/activate identically everywhere. The `scopeId` is threaded from the cockpit.
 */
export function ProjectRightPanelBrowserView(props: Readonly<{
    workspaceRefId: string;
    scopeId?: string;
    /** The enclosing Project's selected Home and checkout, when mounted in its companion. */
    workspaceScope?: WorkspaceScopeBase;
    /** An enclosing Project panel supplies its one admitted projection. */
    pluginProjection?: PluginUiProjectionCurrentness;
}>): React.ReactElement {
    const workspaceRef = useWorkspaceRefById(props.workspaceRefId, props.workspaceScope?.serverId);
    const selectedWorkspaceScope = props.workspaceScope ?? workspaceRef;
    const scopeId = props.scopeId ?? `project:${props.workspaceRefId}:mobile-browser`;
    const scopedPluginProjection = useScopedPluginUiProjection({
        machineId: selectedWorkspaceScope?.machineId ?? null,
        serverId: selectedWorkspaceScope?.serverId ?? null,
        enabled: props.pluginProjection === undefined,
    });
    const pluginProjection = props.pluginProjection ?? scopedPluginProjection;
    // Assemble the live workspace-ranked launchpad feed so the Project new-tab page shows
    // running services + recents, not only URL entry.
    const hostProps = useBrowserSurfaceHostProps({
        scope: 'workspaceDetails',
        workspaceRefId: props.workspaceRefId,
        machineId: selectedWorkspaceScope?.machineId ?? null,
        serverId: selectedWorkspaceScope?.serverId ?? null,
        pluginUiProjection: pluginProjection.pluginUiProjection,
        pluginBrowserProjection: pluginProjection.pluginBrowserProjection,
    });

    // A project's browser belongs to its workspace, not to a session: it gets the real workspace
    // scope (it used to pose as a Session whose id was the workspace ref).
    const workspaceScope = React.useMemo(() => (selectedWorkspaceScope
        ? {
            kind: 'workspace' as const,
            workspaceRefId: props.workspaceRefId,
            serverId: selectedWorkspaceScope.serverId,
            machineId: selectedWorkspaceScope.machineId,
            rootPath: selectedWorkspaceScope.rootPath,
        }
        : null), [props.workspaceRefId, selectedWorkspaceScope]);
    if (!workspaceScope) {
        return <SurfaceStateCard kind="loading" title={t('browserSurface.title')} testID="project-rightpanel-browser-loading" />;
    }

    return (
        <BrowserScopedWorkspace
            scopeId={scopeId}
            scope={workspaceScope}
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
