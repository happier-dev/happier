import * as React from 'react';

import { WorkspaceRepositoryTreeBrowserView } from '@/components/projects/files/WorkspaceRepositoryTreeBrowserView';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export const ProjectBrowseFilesSurface = React.memo((props: Readonly<{
    scope: WorkspaceScopeBase;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned: (fullPath: string) => void;
}>) => {
    return (
        <WorkspaceRepositoryTreeBrowserView
            scope={props.scope}
            onOpenFile={props.onOpenFile}
            onOpenFilePinned={props.onOpenFilePinned}
            density="panel"
        />
    );
});
