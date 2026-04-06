import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { SessionListHeaderItem } from './sessionListHeaderItem';

vi.mock('./sessionListChrome', () => ({
    ProjectGroupHeader: (props: any) => React.createElement('ProjectGroupHeader', props),
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
            workspaceScopeHint: {
                serverId: 'server_a',
                machineId: 'machine_a',
                rootPath: '/repo',
            },
        } as const;
        const onOpenProject = vi.fn();
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
        } as const;

        const screen = await renderScreen(
            <SessionListHeaderItem
                item={item}
                collapsedKeys={{ [projectHeaderViewModel.collapseKey]: true }}
                projectHeaderViewModelByGroupKey={new Map([[projectHeaderViewModel.collapseKey, projectHeaderViewModel]])}
                hasMultipleMachines={true}
                onOpenProject={onOpenProject}
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
                    onRenameWorkspace={onRenameWorkspace}
                    onResetWorkspaceName={onResetWorkspaceName}
                    onToggleCollapse={onToggleCollapse}
                />,
            );
        });

        const secondProjectHeader = screen.findByType('ProjectGroupHeader');
        const secondProps = secondProjectHeader.props;

        expect(secondProps.onOpenProject).toBe(firstProps.onOpenProject);
        expect(secondProps.onRename).toBe(firstProps.onRename);
        expect(secondProps.onReset).toBe(firstProps.onReset);
        expect(secondProps.onToggleCollapse).toBe(firstProps.onToggleCollapse);
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
                    onRenameWorkspace={vi.fn()}
                    onResetWorkspaceName={vi.fn()}
                    onToggleCollapse={onToggleCollapse}
                />,
            );
        });

        expect(activeScreen.findByType('CollapsibleSectionHeader').props.showOrderingMenu).toBe(false);
    });
});
