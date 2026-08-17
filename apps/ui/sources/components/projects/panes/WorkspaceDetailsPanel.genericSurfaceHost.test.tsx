import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const detailsSurfaceHostSpy = vi.hoisted(() => vi.fn((props: unknown) => React.createElement('DetailsSurfaceHostMock', { props })));
const pluginSurfacePlacementStackSpy = vi.hoisted(() => vi.fn((props: unknown) => (
    React.createElement('PluginSurfacePlacementStackMock', { props })
)));
const detailsSplitWorkspaceSpy = vi.hoisted(() => vi.fn((props: any) => React.createElement(
    React.Fragment,
    null,
    props.renderEmptyState?.(),
    props.renderTabContent?.({
        key: 'scm-review',
        kind: 'scmReview',
        title: 'Review',
        isPinned: true,
        isPreview: false,
        resource: { kind: 'scmReview' },
    }),
)));

vi.mock('@/components/appShell/panes/details/surfaces', () => ({
    DetailsSurfaceHost: (props: unknown) => detailsSurfaceHostSpy(props),
    createDetailsSurfacePaneCallbacks: (callbacks: unknown) => callbacks,
}));

vi.mock('@/components/plugins/surfaces/PluginSurfacePlacementStack', () => ({
    PluginSurfacePlacementStack: (props: unknown) => pluginSurfacePlacementStackSpy(props),
}));

vi.mock('expo-router', () => createExpoRouterMock().module);

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { details: { tabState: {} } },
        closeDetails: vi.fn(),
        openDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
    }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'desktop',
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: () => ({
        pluginUiProjection: null,
        pluginBrowserProjection: null,
        phase: 'current',
        interactionEnabled: false,
        machineId: 'machine-1',
        serverId: 'server-1',
        platform: 'web',
    }),
}));

vi.mock('@/components/appShell/panes/details/workspace/DetailsSplitWorkspace', () => ({
    DetailsSplitWorkspace: (props: any) => detailsSplitWorkspaceSpy(props),
}));

vi.mock('@/components/workspaces/files/details/WorkspaceFileDetailsView', () => ({
    WorkspaceFileDetailsView: () => React.createElement('WorkspaceFileDetailsView'),
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceCommitDetailsView', () => ({
    WorkspaceCommitDetailsView: () => React.createElement('WorkspaceCommitDetailsView'),
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceScmReviewDetailsView', () => ({
    WorkspaceScmReviewDetailsView: () => React.createElement('WorkspaceScmReviewDetailsView'),
}));

vi.mock('@/components/projects/panes/details/views/WorkspaceScmStashDetailsView', () => ({
    WorkspaceScmStashDetailsView: () => React.createElement('WorkspaceScmStashDetailsView'),
}));

vi.mock('@/components/projects/detail/surfaces/ProjectTerminalSurface', () => ({
    ProjectTerminalSurface: () => React.createElement('ProjectTerminalSurface'),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createPartialStorageModuleMock(importOriginal, {
        useAllMachines: () => [],
        useLocalSetting: () => false,
        useLocalSettingMutable: () => [false, vi.fn()],
        useWorkspaceReviewCommentsDrafts: () => [],
    });
});

describe('WorkspaceDetailsPanel generic details surface host adapter', () => {
    it('routes workspace detail tabs through the app-shell details surface host with canonical scope identity', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');
        detailsSurfaceHostSpy.mockClear();

        await renderScreen(
            <WorkspaceDetailsPanel
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo/main',
                    label: 'Repo',
                } as any}
                scopeId="project:wr_1"
                activeRootPath="/repo/worktree-a"
            />,
        );

        expect(detailsSurfaceHostSpy).toHaveBeenCalledWith(expect.objectContaining({
            scope: {
                kind: 'project',
                workspaceRefId: 'wr_1',
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/repo/main',
                activeRootPath: '/repo/worktree-a',
            },
            region: 'details',
            tab: expect.objectContaining({ key: 'scm-review' }),
        }));
    });

    it('mounts workspace details plugin surface placements from the overview insertion point', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');
        pluginSurfacePlacementStackSpy.mockClear();

        await renderScreen(
            <WorkspaceDetailsPanel
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo/main',
                    label: 'Repo',
                } as any}
                scopeId="workspace:wr_1"
                activeRootPath="/repo/main"
                {...({ pluginUiProjection: { generation: 1 }, platform: 'web' } as any)}
            />,
        );

        expect(pluginSurfacePlacementStackSpy).toHaveBeenCalledWith(expect.objectContaining({
            placement: 'workspace.details',
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
            pluginUiProjection: { generation: 1 },
        }));
    });

    it('mounts workspace main plugin surface placements without replacing the overview content', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');
        pluginSurfacePlacementStackSpy.mockClear();

        await renderScreen(
            <WorkspaceDetailsPanel
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo/main',
                    label: 'Repo',
                } as any}
                scopeId="workspace:wr_1"
                activeRootPath="/repo/main"
                {...({ pluginUiProjection: { generation: 1 }, platform: 'web' } as any)}
            />,
        );

        expect(pluginSurfacePlacementStackSpy).toHaveBeenCalledWith(expect.objectContaining({
            placement: 'workspace.main',
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
            pluginUiProjection: { generation: 1 },
        }));
        expect(detailsSplitWorkspaceSpy).toHaveBeenCalled();
    });

    it('mounts project main plugin surface placements from project-scoped main content', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');
        pluginSurfacePlacementStackSpy.mockClear();

        await renderScreen(
            <WorkspaceDetailsPanel
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo/main',
                    label: 'Repo',
                } as any}
                scopeId="project:wr_1"
                activeRootPath="/repo/worktree-a"
                pluginSurfacePlacementScope="project"
                {...({ pluginUiProjection: { generation: 2 }, platform: 'web' } as any)}
            />,
        );

        expect(pluginSurfacePlacementStackSpy).toHaveBeenCalledWith(expect.objectContaining({
            placement: 'project.main',
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
            pluginUiProjection: { generation: 2 },
        }));
        expect(pluginSurfacePlacementStackSpy).toHaveBeenCalledWith(expect.objectContaining({
            placement: 'project.details',
            machineId: 'machine-1',
            serverId: 'server-1',
            platform: 'web',
            pluginUiProjection: { generation: 2 },
        }));
    });
});
