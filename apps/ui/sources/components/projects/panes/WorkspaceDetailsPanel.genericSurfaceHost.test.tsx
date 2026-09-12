import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const detailsSurfaceHostSpy = vi.hoisted(() => vi.fn((props: unknown) => React.createElement('DetailsSurfaceHostMock', { props })));
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

    it('registers the canonical project plugin destination renderer with the details host', async () => {
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
                activeRootPath="/repo/main"
                {...({ pluginUiProjection: { generation: 1 }, platform: 'web' } as any)}
            />,
        );

        const hostProps = detailsSurfaceHostSpy.mock.calls.at(-1)?.[0] as {
            renderers?: readonly { id: string; owner: string }[];
        } | undefined;
        expect(hostProps?.renderers).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'plugin-details-destination:project', owner: 'plugin' }),
        ]));
    });

    it('keeps the workspace overview content while the generic details renderer set is available', async () => {
        const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');
        detailsSplitWorkspaceSpy.mockClear();

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

        expect(detailsSplitWorkspaceSpy).toHaveBeenCalledWith(expect.objectContaining({
            renderEmptyState: expect.any(Function),
            renderTabContent: expect.any(Function),
        }));
    });

    it('derives project details scope from the panel owner without a placement-scope override', async () => {
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
                {...({ pluginUiProjection: { generation: 2 }, platform: 'web' } as any)}
            />,
        );

        expect(detailsSurfaceHostSpy).toHaveBeenCalledWith(expect.objectContaining({
            scope: expect.objectContaining({
                kind: 'project',
                workspaceRefId: 'wr_1',
                activeRootPath: '/repo/worktree-a',
            }),
            renderers: expect.arrayContaining([
                expect.objectContaining({ id: 'plugin-details-destination:project', owner: 'plugin' }),
            ]),
        }));
    });
});
