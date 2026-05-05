import * as React from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = createExpoRouterMock({
    params: {
        workspaceRefId: 'wr_1',
        worktreeId: 'gitwt_feature',
    },
});
let deviceTypeMock: 'phone' | 'tablet' | 'desktop' = 'phone';
let rightPaneStateMock: { isOpen: boolean; activeTabId: string | null } = { isOpen: true, activeTabId: 'git' };
let localSettingsMock: Record<string, unknown> = {};
let accountSettingsMock: Record<string, unknown> = {};
const projectDetailScreenSpy = vi.hoisted(() => vi.fn());
const projectCockpitShellSpy = vi.hoisted(() => vi.fn());
const setLocalSettingSpies = vi.hoisted(() => ({
    projectLastMobileSurfaceByWorkspaceRefId: vi.fn(),
    projectLastActiveRootPathByWorkspaceRefId: vi.fn(),
    projectLastActiveWorktreeIdByWorkspaceRefId: vi.fn(),
}));
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
    useDeviceType: () => deviceTypeMock,
}));

vi.mock('@react-navigation/native', () => ({
    useNavigation: () => ({
        canGoBack: () => true,
    }),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: { right: rightPaneStateMock },
    }),
}));

vi.mock('@/components/projects/ProjectDetailScreen', () => ({
    ProjectDetailScreen: (props: Record<string, unknown>) => {
        projectDetailScreenSpy(props);
        return React.createElement('ProjectDetailScreenStub', props);
    },
}));

vi.mock('@/components/workspaceCockpit/project/ProjectCockpitShell', () => ({
    ProjectCockpitShell: (props: Record<string, unknown>) => {
        projectCockpitShellSpy(props);
        return React.createElement('ProjectCockpitShellStub', props);
    },
}));

vi.mock('@/components/projects/detail/useWorkspaceRefById', () => ({
    useWorkspaceRefById: () => workspaceRefMock,
}));

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: () => ({
        snapshot: {
            repo: {
                isRepo: true,
                worktrees: [
                    { id: 'gitwt_main', path: '/Users/test/repo', branch: 'main', isCurrent: true, isMain: true },
                    { id: 'gitwt_feature', path: '/Users/test/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                ],
            },
        },
        loading: false,
        error: null,
        refresh: vi.fn(async () => {}),
    }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: (key: string) => accountSettingsMock[key],
        useLocalSetting: (key: string) => {
            if (key === 'mobileWorkspaceExperienceV1') {
                throw new Error('mobileWorkspaceExperienceV1 must use synced account settings');
            }
            return localSettingsMock[key];
        },
        useLocalSettingMutable: (key: string) => [
            localSettingsMock[key],
            setLocalSettingSpies[key as keyof typeof setLocalSettingSpies] ?? vi.fn(),
        ],
    });
});

describe('project index redirect', () => {
    beforeEach(() => {
        deviceTypeMock = 'phone';
        rightPaneStateMock = { isOpen: true, activeTabId: 'git' };
        localSettingsMock = {};
        accountSettingsMock = {};
        projectDetailScreenSpy.mockClear();
        projectCockpitShellSpy.mockClear();
        Object.values(setLocalSettingSpies).forEach((spy) => spy.mockClear());
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
        expect(redirect.props.href).toBe('/projects/wr_1/git?worktreeId=gitwt_feature');
    });

    it('renders the project cockpit shell on phone when the overview cockpit surface is enabled', async () => {
        rightPaneStateMock = { isOpen: false, activeTabId: null };
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'cockpit' };
        localSettingsMock = {
            projectLastMobileSurfaceByWorkspaceRefId: { wr_1: 'overview' },
        };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const cockpit = screen.tree.findByType('ProjectCockpitShellStub' as never);
        expect(cockpit.props.workspaceRef.id).toBe('wr_1');
        expect(cockpit.props.surface).toBe('overview');
        expect(screen.tree.findAllByType('Redirect' as never)).toHaveLength(0);
    });

    it('canonicalizes an invalid persisted worktree before reopening a cockpit-only surface from the index route', async () => {
        rightPaneStateMock = { isOpen: false, activeTabId: null };
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'cockpit' };
        localSettingsMock = {
            projectLastMobileSurfaceByWorkspaceRefId: { wr_1: 'terminal' },
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/.worktrees/deleted-worktree' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_deleted' },
        };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/terminal?worktreeId=%40root');

        expect(setLocalSettingSpies.projectLastActiveRootPathByWorkspaceRefId).not.toHaveBeenCalledWith(
            expect.objectContaining({ wr_1: '/Users/test/repo/.worktrees/deleted-worktree' }),
        );
    });

    it('defaults the phone redirect to files when no last project tab is remembered', async () => {
        rightPaneStateMock = { isOpen: false, activeTabId: null };
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'classic' };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/files?worktreeId=%40root');
    });

    it('ignores the retired persisted mobile project route state when url state is absent', async () => {
        rightPaneStateMock = { isOpen: false, activeTabId: null };
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'classic' };
        localSettingsMock = {
            projectLastMobileRouteByWorkspaceRefId: { wr_1: 'git' },
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/.worktrees/feature-auth' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_feature' },
        };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/files?worktreeId=gitwt_feature');
    });

    it('falls back to persisted cockpit-era mobile surface state when url state is absent', async () => {
        rightPaneStateMock = { isOpen: false, activeTabId: null };
        localSettingsMock = {
            projectLastMobileSurfaceByWorkspaceRefId: { wr_1: 'browse' },
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/.worktrees/feature-auth' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_feature' },
        };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/files?worktreeId=gitwt_feature');
    });

    it('drops an invalid persisted worktree selection before redirecting phone routes', async () => {
        rightPaneStateMock = { isOpen: false, activeTabId: null };
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'classic' };
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: { wr_1: '/Users/test/repo/.worktrees/deleted-worktree' },
            projectLastActiveWorktreeIdByWorkspaceRefId: { wr_1: 'gitwt_deleted' },
        };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: undefined,
            activeRootPath: undefined,
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/files?worktreeId=%40root');
    });

    it('repairs an invalid explicit worktreeId before redirecting phone routes', async () => {
        rightPaneStateMock = { isOpen: false, activeTabId: null };
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'classic' };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: 'gitwt_deleted',
            activeRootPath: undefined,
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/files?worktreeId=%40root');
    });

    it('preserves a deep-linked activeRootPath before the workspace ref has loaded', async () => {
        workspaceRefMock = null;
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: 'gitwt_feature',
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/git?worktreeId=gitwt_feature');
    });

    it('preserves persisted cockpit-only surfaces before the workspace ref has loaded', async () => {
        workspaceRefMock = null;
        accountSettingsMock = { mobileWorkspaceExperienceV1: 'cockpit' };
        localSettingsMock = {
            projectLastMobileSurfaceByWorkspaceRefId: { wr_1: 'terminal' },
        };
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            worktreeId: 'gitwt_feature',
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);

        const redirect = screen.tree.findByType('Redirect' as never);
        expect(redirect.props.href).toBe('/projects/wr_1/terminal?worktreeId=gitwt_feature');
    });

    it('replaces the desktop route with the canonical project href when switching back to the main repository', async () => {
        deviceTypeMock = 'desktop';
        routerMock.spies.replace.mockClear();

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);
        const detail = screen.tree.findByType('ProjectDetailScreenStub' as never);

        await act(async () => {
            detail.props.onSelectRootPath('/Users/test/repo');
        });

        expect(routerMock.spies.replace).toHaveBeenCalledWith('/projects/wr_1?worktreeId=%40root');
    });

    it('passes the desktop worktree-overview mode into the project screen when requested', async () => {
        deviceTypeMock = 'desktop';
        routerMock.state.router.setParams({
            workspaceRefId: 'wr_1',
            showWorktrees: '1',
        });

        const Screen = (await import('@/app/(app)/projects/[workspaceRefId]/index')).default;
        const screen = await renderScreen(<Screen />);
        const detail = screen.tree.findByType('ProjectDetailScreenStub' as never);

        expect(detail.props.showWorktrees).toBe(true);
    });
});
