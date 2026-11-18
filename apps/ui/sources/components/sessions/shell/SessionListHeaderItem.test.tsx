import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SessionListHeaderItem } from './sessionListHeaderItem';

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

vi.mock('./sessionListChrome', async () => {
    const ReactModule = await import('react');
    const CollapsibleSectionHeader = ReactModule.forwardRef((props: any, ref) => ReactModule.createElement('CollapsibleSectionHeader', { ...props, ref }));
    return {
        ProjectGroupHeader: (props: any) => ReactModule.createElement('ProjectGroupHeader', props),
        SessionSectionHeader: (props: any) => ReactModule.createElement('SessionSectionHeader', props),
        CollapsibleSectionHeader,
    };
});

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
            await screen.update(
                <SessionListHeaderItem
                    item={{ ...item }}
                    collapsedKeys={{ [projectHeaderViewModel.collapseKey]: true }}
                    projectHeaderViewModelByGroupKey={new Map([[projectHeaderViewModel.collapseKey, projectHeaderViewModel]])}

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

        secondProps.onOpenProject();
        expect(onOpenProject).toHaveBeenCalledWith('workspace-ref-1', 'server_a');

        secondProps.onCreateSession();
        expect(onCreateSessionFromWorkspaceScope).toHaveBeenCalledWith(item.workspaceScopeHint, {
            seedSessionId: 'seed-session',
        });
    });



    it('does not pass drag-hover outline state into header chrome', async () => {
        const screen = await renderScreen(
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

                onOpenProject={vi.fn()}
                onCreateSessionFromWorkspaceScope={vi.fn()}
                onAddFolderToWorkspace={vi.fn()}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onToggleCollapse={vi.fn()}
            />,
        );

        const folderHeader = screen.findByType('SessionSectionHeader');
        expect(folderHeader.props).not.toHaveProperty('activeDropTargetId');
    });
});
