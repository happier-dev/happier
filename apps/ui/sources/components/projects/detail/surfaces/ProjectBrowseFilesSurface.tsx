import * as React from 'react';

import { WorkspaceRepositoryTreeBrowserView } from '@/components/projects/files/WorkspaceRepositoryTreeBrowserView';

export const ProjectBrowseFilesSurface = React.memo((props: Readonly<{
    workspaceCacheKey: string;
    serverId: string;
    machineId: string;
    rootPath: string;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned: (fullPath: string) => void;
}>) => {
    return (
        <WorkspaceRepositoryTreeBrowserView
            workspaceCacheKey={props.workspaceCacheKey}
            serverId={props.serverId}
            machineId={props.machineId}
            rootPath={props.rootPath}
            onOpenFile={props.onOpenFile}
            onOpenFilePinned={props.onOpenFilePinned}
            density="panel"
        />
    );
});
