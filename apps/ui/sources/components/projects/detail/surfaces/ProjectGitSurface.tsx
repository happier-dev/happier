import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useWorkspaceScmTabState } from '@/components/workspaces/scm/useWorkspaceScmTabState';
import * as React from 'react';
import { View } from 'react-native';

import { WorkspaceRightPanelGitView } from '@/components/projects/scm/WorkspaceRightPanelGitView';
import { WorkspaceScmReviewDetailsView } from '@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView';
import { useScmReviewTabState } from '@/components/sessions/files/comparison/useSessionScmReviewTabState';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { t } from '@/text';
import { useDestinationParams } from '@/components/appShell/workspace/DestinationInstanceHost';
import { parseSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';

export const ProjectGitSurface = React.memo((props: Readonly<{
    scopeId: string;
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
    const pane = useAppPaneScope(props.scopeId);
    const params = useDestinationParams<Record<string, string | string[] | undefined>>();
    const routeResource = parseSessionPaneUrlState(params)?.details;
    const { activeGitSubTab, setActiveGitSubTab } = useWorkspaceScmTabState(pane);
    const { persistedReviewTabState, setPersistedReviewTabState } = useScmReviewTabState(
        JSON.stringify([props.serverId, props.machineId, props.rootPath]), pane);
    const mode = persistedReviewTabState?.projectChangesMode === 'git' ? 'git' : 'review';
    return (
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
            <SegmentedTabBar tabs={[{ id: 'review', label: t('files.toolbar.review') }, { id: 'git', label: t('session.rightPanel.tabs.git') }]}
                activeTabId={mode} onSelectTab={(next) => setPersistedReviewTabState({ projectChangesMode: next })}
                testIDPrefix="project-changes-mode" segmentSizing="content" />
            {mode === 'review' ? <WorkspaceScmReviewDetailsView scopeId={props.scopeId}
                {...(routeResource?.kind === 'scmReview' ? routeResource : {})}
                serverId={props.serverId} machineId={props.machineId} rootPath={props.rootPath}
                onOpenFile={props.onOpenFile} onOpenFilePinned={props.onOpenFilePinned}
                onShowInGit={() => { setPersistedReviewTabState({ projectChangesMode: 'git' }); setActiveGitSubTab('commit'); }} /> : <WorkspaceRightPanelGitView
            activeSubTabId={activeGitSubTab}
            onActiveSubTabChange={setActiveGitSubTab}
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
        />}
        </View>
    );
});
