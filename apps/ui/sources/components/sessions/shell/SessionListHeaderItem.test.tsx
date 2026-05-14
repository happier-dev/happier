import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SessionListHeaderItem } from './sessionListHeaderItem';

const useSessionInlineDragSpy = vi.hoisted(() => vi.fn((_: any) => ({ gesture: undefined, animatedStyle: {} })));

vi.mock('./sessionListChrome', () => ({
    ProjectGroupHeader: (props: any) => React.createElement('ProjectGroupHeader', props),
    FolderGroupHeader: (props: any) => React.createElement('FolderGroupHeader', props),
    CollapsibleSectionHeader: (props: any) => React.createElement('CollapsibleSectionHeader', props),
}));

vi.mock('./useSessionInlineDrag', () => ({
    useSessionInlineDrag: (params: any) => useSessionInlineDragSpy(params),
}));

describe('SessionListHeaderItem', () => {
    it('reuses the same project-header callbacks when rerendered with identical inputs', async () => {
        const item = {
            type: 'header',
            title: '/repo',
            headerKind: 'project',
            groupKey: 'project:repo',
            workspaceKey: 'legacy_repo',
            seedSessionId: 'seed-session',
            workspaceScopeHint: {
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
            },
        } as const;
        const onOpenProject = vi.fn();
        const onCreateSessionFromWorkspaceScope = vi.fn();
        const onRenameWorkspace = vi.fn();
        const onResetWorkspaceName = vi.fn();
        const onToggleCollapse = vi.fn();

        const projectHeaderViewModel = {
            collapseKey: 'project:repo',
            displayTitle: 'Important Repo',
            hasCustomLabel: true,
            workspaceRefId: 'workspace-ref-1',
            legacyWorkspaceKey: 'legacy_repo',
            scopeHint: {
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
            },
            seedSessionId: 'seed-session',
        } as const;

        const screen = await renderScreen(
            <SessionListHeaderItem
                item={item}
                collapsedKeys={{ [projectHeaderViewModel.collapseKey]: true }}
                projectHeaderViewModelByGroupKey={new Map([[projectHeaderViewModel.collapseKey, projectHeaderViewModel]])}
                hasMultipleMachines={true}
                onOpenProject={onOpenProject}
                onCreateSessionFromWorkspaceScope={onCreateSessionFromWorkspaceScope}
                onAddFolderToWorkspace={vi.fn()}
                onRenameWorkspace={onRenameWorkspace}
                onResetWorkspaceName={onResetWorkspaceName}
                onToggleCollapse={onToggleCollapse}
            />,
        );

        const firstProjectHeader = screen.findByType('ProjectGroupHeader');
        const firstProps = firstProjectHeader.props;

        await act(async () => {
            screen.tree.update(
                <SessionListHeaderItem
                    item={{ ...item }}
                    collapsedKeys={{ [projectHeaderViewModel.collapseKey]: true }}
                    projectHeaderViewModelByGroupKey={new Map([[projectHeaderViewModel.collapseKey, projectHeaderViewModel]])}
                    hasMultipleMachines={true}
                    onOpenProject={onOpenProject}
                    onCreateSessionFromWorkspaceScope={onCreateSessionFromWorkspaceScope}
                    onAddFolderToWorkspace={vi.fn()}
                    onRenameWorkspace={onRenameWorkspace}
                    onResetWorkspaceName={onResetWorkspaceName}
                    onToggleCollapse={onToggleCollapse}
                />,
            );
        });

        const secondProjectHeader = screen.findByType('ProjectGroupHeader');
        const secondProps = secondProjectHeader.props;

        expect(secondProps.onOpenProject).toBe(firstProps.onOpenProject);
        expect(secondProps.onCreateSession).toBe(firstProps.onCreateSession);
        expect(secondProps.onRename).toBe(firstProps.onRename);
        expect(secondProps.onReset).toBe(firstProps.onReset);
        expect(secondProps.onToggleCollapse).toBe(firstProps.onToggleCollapse);

        secondProps.onCreateSession();
        expect(onCreateSessionFromWorkspaceScope).toHaveBeenCalledWith(item.workspaceScopeHint, {
            seedSessionId: 'seed-session',
        });
    });

    it('shows the ordering menu affordance on active and inactive section headers only', async () => {
        const onToggleCollapse = vi.fn();

        const activeScreen = await renderScreen(
            <SessionListHeaderItem
                item={{ type: 'header', title: 'Active', headerKind: 'active', groupKey: 'active:server_a', serverId: 'server_a' } as any}
                collapsedKeys={{}}
                projectHeaderViewModelByGroupKey={new Map()}
                hasMultipleMachines={false}
                onOpenProject={vi.fn()}
                onCreateSessionFromWorkspaceScope={vi.fn()}
                onAddFolderToWorkspace={vi.fn()}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onToggleCollapse={onToggleCollapse}
            />,
        );

        expect(activeScreen.findByType('CollapsibleSectionHeader').props.showOrderingMenu).toBe(true);

        await act(async () => {
            activeScreen.tree.update(
                <SessionListHeaderItem
                    item={{ type: 'header', title: 'Inactive', headerKind: 'inactive', groupKey: 'inactive:server_a', serverId: 'server_a' } as any}
                    collapsedKeys={{}}
                    projectHeaderViewModelByGroupKey={new Map()}
                    hasMultipleMachines={false}
                    onOpenProject={vi.fn()}
                    onCreateSessionFromWorkspaceScope={vi.fn()}
                    onAddFolderToWorkspace={vi.fn()}
                    onRenameWorkspace={vi.fn()}
                    onResetWorkspaceName={vi.fn()}
                    onToggleCollapse={onToggleCollapse}
                />,
            );
        });

        expect(activeScreen.findByType('CollapsibleSectionHeader').props.showOrderingMenu).toBe(true);

        await act(async () => {
            activeScreen.tree.update(
                <SessionListHeaderItem
                    item={{ type: 'header', title: 'Server A', headerKind: 'server', groupKey: 'server:server_a', serverId: 'server_a' } as any}
                    collapsedKeys={{}}
                    projectHeaderViewModelByGroupKey={new Map()}
                    hasMultipleMachines={false}
                    onOpenProject={vi.fn()}
                    onCreateSessionFromWorkspaceScope={vi.fn()}
                    onAddFolderToWorkspace={vi.fn()}
                    onRenameWorkspace={vi.fn()}
                    onResetWorkspaceName={vi.fn()}
                    onToggleCollapse={onToggleCollapse}
                />,
            );
        });

        expect(activeScreen.findByType('CollapsibleSectionHeader').props.showOrderingMenu).toBe(false);
    });

    it('wires folder headers into the shared inline drag hook', async () => {
        const dropIndicatorIdx = { value: -1 } as any;
        const dropIndicatorEdge = { value: 0 } as any;
        const onFolderDragStart = vi.fn();
        const onFolderDragEnd = vi.fn();
        const onFolderDragUpdate = vi.fn();

        await renderScreen(
            <SessionListHeaderItem
                item={{
                    type: 'header',
                    title: 'Planning',
                    headerKind: 'folder',
                    groupKey: 'folder:folder_planning',
                    folderId: 'folder_planning',
                    folderDepth: 0,
                    serverId: 'server_a',
                    workspace: { t: 'workspaceRef', serverId: 'server_a', workspaceRefId: 'workspace_a' },
                } as any}
                collapsedKeys={{}}
                projectHeaderViewModelByGroupKey={new Map()}
                hasMultipleMachines={false}
                onOpenProject={vi.fn()}
                onCreateSessionFromWorkspaceScope={vi.fn()}
                onAddFolderToWorkspace={vi.fn()}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onToggleCollapse={vi.fn()}
                dataIndex={3}
                totalItemCount={8}
                dropIndicatorIdx={dropIndicatorIdx}
                dropIndicatorEdge={dropIndicatorEdge}
                onFolderDragStart={onFolderDragStart}
                onFolderDragEnd={onFolderDragEnd}
                onFolderDragUpdate={onFolderDragUpdate}
                activeFolderDropTargetId="folder:target"
            />,
        );

        expect(useSessionInlineDragSpy).toHaveBeenCalledWith(expect.objectContaining({
            enabled: true,
            sessionKey: 'folder:folder_planning',
            groupKey: 'folder:folder_planning',
            rowHeight: 28,
            dataIndex: 3,
            totalItemCount: 8,
            dropIndicatorIdx,
            dropIndicatorEdge,
            onDragStart: onFolderDragStart,
            onDragUpdate: onFolderDragUpdate,
        }));
        expect(onFolderDragEnd).not.toHaveBeenCalled();
    });
});
