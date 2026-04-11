import * as React from 'react';

import { WorkspaceRightPanelGitView } from '@/components/projects/scm/WorkspaceRightPanelGitView';

export const ProjectGitSurface = React.memo((props: Readonly<{
    serverId: string;
    machineId: string;
    rootPath: string;
    onOpenFile: (fullPath: string) => void;
    onOpenFilePinned: (fullPath: string) => void;
    onOpenReviewAllChanges: () => void;
    onOpenStashDetails: () => void;
    onOpenCommit: (sha: string) => void;
    onSelectWorkspacePath: (path: string) => void;
    onRequestCreateWorktreeFromAnotherBranch: () => void;
    onRevealInFilesTree: (fullPath: string) => void;
}>) => {
    return (
        <WorkspaceRightPanelGitView
            serverId={props.serverId}
            machineId={props.machineId}
            rootPath={props.rootPath}
            onOpenFile={props.onOpenFile}
            onOpenFilePinned={props.onOpenFilePinned}
            onOpenReviewAllChanges={props.onOpenReviewAllChanges}
            onOpenStashDetails={props.onOpenStashDetails}
            onOpenCommit={props.onOpenCommit}
            onSelectWorkspacePath={props.onSelectWorkspacePath}
            onRequestCreateWorktreeFromAnotherBranch={props.onRequestCreateWorktreeFromAnotherBranch}
            onRevealInFilesTree={props.onRevealInFilesTree}
        />
    );
});
