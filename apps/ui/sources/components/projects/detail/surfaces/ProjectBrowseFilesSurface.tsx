import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import * as React from 'react';

import { resolveOpenDetailsFilePath } from '@/components/workspaces/files/resolveOpenDetailsFilePath';

import { WorkspaceCodeBrowserView, type WorkspaceCodeLocation } from '@/components/projects/files/code/WorkspaceCodeBrowserView';
import { useRepositoryTreeBrowserState } from '@/hooks/workspaces/files/repositoryTreeBrowserState';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { buildProjectRouteHref } from '../projectRouteState';

export const ProjectBrowseFilesSurface = React.memo((props: Readonly<{
    scopeId: string;
    scope: WorkspaceScopeBase;
    workspaceRef: WorkspaceRefV1;
    activeWorktreeId?: string | null;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned: (fullPath: string) => void;
    /** The page route owns back/up and deep-link navigation when mounted as Code. */
    location?: WorkspaceCodeLocation;
    onNavigate?: (location: WorkspaceCodeLocation) => void;
    onOpenHistory?: (location: WorkspaceCodeLocation) => void;
}>) => {
    const pane = useAppPaneScope(props.scopeId);
    const { location, setLocation } = useRepositoryTreeBrowserState(tryBuildWorkspaceCacheKey(props.scope) ?? '');
    // A controlled Code route owns file pages. The incumbent Files companion promotes files to
    // Details, and shows their containing folder if the shared Code location is already a file.
    const companionLocation: WorkspaceCodeLocation = location.kind === 'file'
        ? { kind: 'folder', path: location.path.slice(0, Math.max(0, location.path.lastIndexOf('/'))) }
        : location;
    const onNavigate = React.useCallback((next: WorkspaceCodeLocation) => {
        if (props.onNavigate) props.onNavigate(next);
        else if (next.kind === 'file') props.onOpenFile(next.path);
        else setLocation(next);
    }, [props.onNavigate, props.onOpenFile, setLocation]);
    const fileHref = React.useCallback((path: string) => buildProjectRouteHref({
        workspaceRefId: props.workspaceRef.id, serverId: props.workspaceRef.serverId, segment: 'code', activeRootPath: props.scope.rootPath,
        defaultRootPath: props.workspaceRef.rootPath, activeWorktreeId: props.activeWorktreeId,
        ...(props.onNavigate ? { initialResource: null, codeLocation: { kind: 'file', path } } : {
            sourceSurface: 'browse', initialResource: { kind: 'file', path },
        }),
    }), [props.activeWorktreeId, props.onNavigate, props.scope.rootPath, props.workspaceRef.id, props.workspaceRef.serverId, props.workspaceRef.rootPath]);
    const files = pane.scopeState?.right.tabState.files as { revealRequest?: Readonly<{ path: string }> } | undefined;
    // The row of the file open in Details stays selected while its tab is open (lab F1).
    const selectedPath = resolveOpenDetailsFilePath(pane.scopeState?.details);
    return (
        <WorkspaceCodeBrowserView
            paneScopeId={props.scopeId}
            rootLabel={resolveWorkspaceRefDisplayName(props.workspaceRef)}
            location={props.location ?? companionLocation}
            onNavigate={onNavigate}
            onOpenHistory={props.onOpenHistory}
            fileHref={fileHref}
            scope={props.scope}
            onOpenFilePinned={props.onOpenFilePinned}
            onEditFile={props.onOpenFilePinned}
            revealRequest={files?.revealRequest}
            selectedPath={selectedPath}
        />
    );
});
