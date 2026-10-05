import React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SessionListHeaderItem } from './sessionListHeaderItem';

const spotlightTestState = vi.hoisted(() => ({
    active: false,
    mounts: 0,
    unmounts: 0,
}));

vi.mock('@/components/onboarding/tour/stage/useSpotlightTarget', () => ({
    useSpotlightTarget: () => ({
        active: spotlightTestState.active,
        onLayout: vi.fn(),
        style: spotlightTestState.active ? { zIndex: 1 } : undefined,
    }),
}));

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
    const CollapsibleSectionHeader = ReactModule.forwardRef((props: any, ref) => {
        ReactModule.useEffect(() => {
            spotlightTestState.mounts += 1;
            return () => {
                spotlightTestState.unmounts += 1;
            };
        }, []);
        return ReactModule.createElement('CollapsibleSectionHeader', { ...props, ref });
    });
    return {
        ProjectGroupHeader: (props: any) => ReactModule.createElement('ProjectGroupHeader', props),
        FolderGroupHeader: (props: any) => ReactModule.createElement('FolderGroupHeader', props),
        CollapsibleSectionHeader,
    };
});

describe('SessionListHeaderItem', () => {
    beforeEach(() => {
        spotlightTestState.active = false;
        spotlightTestState.mounts = 0;
        spotlightTestState.unmounts = 0;
    });


    it('keeps the attention header mounted when its spotlight registration activates', async () => {
        const item = {
            type: 'header',
            title: 'Needs attention',
            headerKind: 'attention',
            groupKey: 'attention',
        } as const;
        const commonProps = {
            collapsedKeys: {},
            projectHeaderViewModelByGroupKey: new Map(),
            hasMultipleMachines: false,
            onOpenProject: vi.fn(),
            onCreateSessionFromWorkspaceScope: vi.fn(),
            onAddFolderToWorkspace: vi.fn(),
            onRenameWorkspace: vi.fn(),
            onResetWorkspaceName: vi.fn(),
            onToggleCollapse: vi.fn(),
        };
        const screen = await renderScreen(
            <SessionListHeaderItem item={item as any} {...commonProps} />,
        );

        expect(spotlightTestState.mounts).toBe(1);
        expect(spotlightTestState.unmounts).toBe(0);

        spotlightTestState.active = true;
        await act(async () => {
            screen.tree.update(<SessionListHeaderItem item={{ ...item } as any} {...commonProps} />);
        });

        expect(spotlightTestState.mounts).toBe(1);
        expect(spotlightTestState.unmounts).toBe(0);
    });

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
                hasMultipleMachines={false}
                onOpenProject={vi.fn()}
                onCreateSessionFromWorkspaceScope={vi.fn()}
                onAddFolderToWorkspace={vi.fn()}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onToggleCollapse={vi.fn()}
            />,
        );

        const folderHeader = screen.findByType('FolderGroupHeader');
        expect(folderHeader.props).not.toHaveProperty('activeDropTargetId');
    });
});
