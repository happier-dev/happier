import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let deviceTypeMock: 'phone' | 'tablet' | 'desktop' = 'tablet';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'ios' },
        View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeMock,
}));

const workspaceDetailsPanelSpy = vi.hoisted(() => vi.fn());
const workspaceScmSnapshotControllerSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/projects/panes/WorkspaceDetailsPanel', () => ({
    WorkspaceDetailsPanel: (props: any) => {
        workspaceDetailsPanelSpy(props);
        return React.createElement('WorkspaceDetailsPanelStub', props);
    },
}));
vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: (scope: unknown) => {
        workspaceScmSnapshotControllerSpy(scope);
        return {
            snapshot: { repo: { isRepo: true, worktrees: [] } },
            loading: false,
            error: null,
            refresh: vi.fn(async () => {}),
        };
    },
}));

describe('ProjectDetailsMainPanel', () => {
    it('keeps the main project surface anchored to the base root while sourcing the worktree list from the base repo snapshot', async () => {
        deviceTypeMock = 'tablet';
        workspaceDetailsPanelSpy.mockClear();
        workspaceScmSnapshotControllerSpy.mockClear();
        const { ProjectDetailsMainPanel } = await import('./ProjectDetailsMainPanel');

        await renderScreen(
            <ProjectDetailsMainPanel
                scopeId="project:wr_1"
                activeRootPath="/repo/.worktrees/feature-auth"
                activeWorktreeId="gitwt_feature"
                onSelectRootPath={() => {}}
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                    createdAtMs: 1,
                } satisfies WorkspaceRefV1}
            />,
        );

        expect(workspaceDetailsPanelSpy).toHaveBeenCalledTimes(1);
        expect(workspaceDetailsPanelSpy).toHaveBeenCalledWith(expect.objectContaining({
            scopeId: 'project:wr_1',
            activeRootPath: '/repo/.worktrees/feature-auth',
            displayPathOverride: '/repo',
            pluginSurfacePlacementScope: 'project',
            workspaceRef: expect.objectContaining({
                id: 'wr_1',
                serverId: 's1',
                machineId: 'm1',
                rootPath: '/repo',
            }),
        }));
        expect(workspaceScmSnapshotControllerSpy).toHaveBeenCalledWith({
            serverId: 's1',
            machineId: 'm1',
            rootPath: '/repo',
        });
    });

    it('keeps the worktree list available on phone for the fullscreen details route', async () => {
        deviceTypeMock = 'phone';
        workspaceDetailsPanelSpy.mockClear();
        const { ProjectDetailsMainPanel } = await import('./ProjectDetailsMainPanel');

        await renderScreen(
            <ProjectDetailsMainPanel
                scopeId="project:wr_1"
                activeRootPath="/repo/.worktrees/feature-auth"
                activeWorktreeId="gitwt_feature"
                onSelectRootPath={() => {}}
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                    createdAtMs: 1,
                } satisfies WorkspaceRefV1}
            />,
        );

        const props = workspaceDetailsPanelSpy.mock.calls.at(-1)?.[0] as {
            renderEmptyStateSupplementaryContent?: () => React.ReactNode;
        };
        expect(props.renderEmptyStateSupplementaryContent).toBeTypeOf('function');
        expect(props.renderEmptyStateSupplementaryContent?.()).toBeTruthy();
    });

    it('forwards project plugin placement projection to the shared workspace details panel', async () => {
        deviceTypeMock = 'tablet';
        workspaceDetailsPanelSpy.mockClear();
        const { ProjectDetailsMainPanel } = await import('./ProjectDetailsMainPanel');
        const pluginUiProjection = { generation: 2 };

        await renderScreen(
            <ProjectDetailsMainPanel
                scopeId="project:wr_1"
                activeRootPath="/repo"
                activeWorktreeId={null}
                onSelectRootPath={() => {}}
                workspaceRef={{
                    id: 'wr_1',
                    serverId: 's1',
                    machineId: 'm1',
                    rootPath: '/repo',
                    createdAtMs: 1,
                } satisfies WorkspaceRefV1}
                {...({ pluginUiProjection, platform: 'web' } as any)}
            />,
        );

        expect(workspaceDetailsPanelSpy).toHaveBeenCalledWith(expect.objectContaining({
            pluginUiProjection,
            platform: 'web',
            pluginSurfacePlacementScope: 'project',
        }));
    });
});
