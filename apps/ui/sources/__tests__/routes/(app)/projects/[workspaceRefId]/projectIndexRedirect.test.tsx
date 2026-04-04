import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = createExpoRouterMock({
    params: {
        workspaceRefId: 'wr_1',
        activeRootPath: '/Users/test/repo/.worktrees/feature-auth',
    },
});
let rightPaneStateMock: { isOpen: boolean; activeTabId: string | null } = { isOpen: true, activeTabId: 'git' };
let localSettingsMock: Record<string, unknown> = {};
let workspaceRefMock: {
    id: string;
    serverId: string;
    machineId: string;
    rootPath: string;
    label: string;
    createdAtMs: number;
} | null = {
    id: 'wr_1',
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/Users/test/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
};

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { right: rightPaneStateMock },
    }),
}));

vi.mock('@/components/projects/ProjectDetailScreen', () => ({
    ProjectDetailScreen: () => React.createElement('ProjectDetailScreenStub'),
}));

vi.mock('@/components/projects/detail/useWorkspaceRefById', () => ({
    useWorkspaceRefById: () => workspaceRefMock,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => localSettingsMock[key],
    });
});

describe('project index redirect', () => {
    beforeEach(() => {
        rightPaneStateMock = { isOpen: true, activeTabId: 'git' };
        localSettingsMock = {};
        workspaceRefMock = {
            id: 'wr_1',
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/Users/test/repo',
            label: 'Project Alpha',
            createdAtMs: 1,
        };
        routerMock.state.router.setParams({});
    });

    afterEach(() => {
        standardCleanup();
    });

    it('preserves the active root path search param when redirecting phone routes', async () => {
        rightPaneStateMock = { isOpen: true, activeTabId: 'git' };
        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/git?activeRootPath=%2FUsers%2Ftest%2Frepo%2F.worktrees%2Ffeature-auth');
    });

    it('defaults the phone redirect to files when no last project tab is remembered', async () => {
        rightPaneStateMock = { isOpen: false, activeTabId: null };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            activeRootPath: undefined,
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/files');
    });

    it('falls back to persisted mobile project route state when url state is absent', async () => {
        rightPaneStateMock = { isOpen: false, activeTabId: null };
        localSettingsMock = {
            projectLastMobileRouteByWorkspaceRefId: { wr_1: 'git' },
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/.worktrees/feature-auth' },
        };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            activeRootPath: undefined,
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/git?activeRootPath=%2FUsers%2Ftest%2Frepo%2F.worktrees%2Ffeature-auth');
    });

    it('preserves a deep-linked activeRootPath before the workspace ref has loaded', async () => {
        workspaceRefMock = null;
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            activeRootPath: '/Users/test/repo/.worktrees/feature-auth',
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/git?activeRootPath=%2FUsers%2Ftest%2Frepo%2F.worktrees%2Ffeature-auth');
    });
});
