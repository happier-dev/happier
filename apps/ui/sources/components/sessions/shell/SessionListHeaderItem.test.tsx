import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { findGestureByKind, renderScreen } from '@/dev/testkit';

import { SessionListHeaderItem } from './sessionListHeaderItem';

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-reanimated', () => ({
    default: { View: (props: any) => React.createElement('Animated.View', props) },
    useSharedValue: (initial: unknown) => ({ value: initial }),
    useAnimatedStyle: (fn: () => unknown) => fn(),
    withSpring: (value: unknown) => value,
}));

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

vi.mock('./sessionListChrome', () => ({
    ProjectGroupHeader: (props: any) => React.createElement('ProjectGroupHeader', props),
    FolderGroupHeader: (props: any) => React.createElement('FolderGroupHeader', props),
    CollapsibleSectionHeader: (props: any) => React.createElement('CollapsibleSectionHeader', props),
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

    it('wires folder headers into the shared inline drag gesture', async () => {
        const dropVisual = {
            visualKind: { value: 0 as const },
            visualTargetId: { value: null as string | null },
            visualEdge: { value: null as 'top' | 'bottom' | null },
            visualDepth: { value: 0 },
        };
        const onFolderDragStart = vi.fn();
        const onFolderDropResult = vi.fn();
        const onFolderDragUpdate = vi.fn();
        const resolveDropResult = vi.fn(() => ({
            instruction: { kind: 'idle' },
            visual: { kind: 'none' },
        } as const));

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
                hasMultipleMachines={false}
                onOpenProject={vi.fn()}
                onCreateSessionFromWorkspaceScope={vi.fn()}
                onAddFolderToWorkspace={vi.fn()}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onToggleCollapse={vi.fn()}
                dataIndex={3}
                dropVisual={dropVisual}
                activeDropVisual={{ kind: 'none' }}
                onFolderDragStart={onFolderDragStart}
                onFolderDropResult={onFolderDropResult}
                onFolderDragUpdate={onFolderDragUpdate}
                resolveDropResult={resolveDropResult}
                activeFolderDropTargetId="folder:target"
            />,
        );

        const panGesture = screen.root
            .findAll((node) => String(node.type) === 'GestureDetector')
            .map((node) => findGestureByKind(node.props.gesture, 'pan'))
            .find(Boolean);
        expect(panGesture).toBeTruthy();
        expect(onFolderDropResult).not.toHaveBeenCalled();
    });
});
