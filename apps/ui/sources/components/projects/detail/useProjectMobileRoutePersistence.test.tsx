import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = createExpoRouterMock();
let localSettingsMock: Record<string, unknown> = {};
let projectLastMobileSurfaceMock: string | null = null;
const persistProjectLastMobileSurfaceSpy = vi.hoisted(() => vi.fn());
const setLocalSettingSpies = vi.hoisted(() => ({
    projectLastActiveRootPathByWorkspaceRefId: vi.fn(),
    projectLastActiveWorktreeIdByWorkspaceRefId: vi.fn(),
}));

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => localSettingsMock[key],
        useLocalSettingMutable: (key: string) => [
            localSettingsMock[key],
            setLocalSettingSpies[key as keyof typeof setLocalSettingSpies] ?? vi.fn(),
        ],
        useProjectLastMobileSurface: () => projectLastMobileSurfaceMock,
        usePersistProjectLastMobileSurface: () => persistProjectLastMobileSurfaceSpy,
    });
});

vi.mock('@/hooks/workspaces/scm/useWorkspaceScmSnapshotController', () => ({
    useWorkspaceScmSnapshotController: () => ({
        snapshot: {
            repo: {
                isRepo: true,
                worktrees: [
                    { id: 'gitwt_main', path: '/repo', branch: 'main', isCurrent: true, isMain: true },
                    { id: 'gitwt_feature', path: '/repo/.worktrees/feature-auth', branch: 'feature/auth', isCurrent: false },
                ],
            },
        },
        loading: false,
        error: null,
        refresh: vi.fn(async () => {}),
    }),
}));

const workspaceRef: WorkspaceRefV1 = {
    id: 'wr_1',
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
    lastOpenedAtMs: null,
};

describe('useProjectMobileRoutePersistence', () => {
    it('canonicalizes a stale explicit worktreeId query param back to the root route selection', async () => {
        localSettingsMock = {};
        projectLastMobileSurfaceMock = null;
        persistProjectLastMobileSurfaceSpy.mockClear();
        Object.values(setLocalSettingSpies).forEach((spy) => spy.mockClear());
        routerMock.spies.replace.mockClear();
        routerMock.state.router.setParams({});

        const { useProjectMobileRoutePersistence } = await import('./useProjectMobileRoutePersistence');
        const hook = await renderHook(() => useProjectMobileRoutePersistence({
            workspaceRef,
            isFocused: true,
            rawWorktreeId: 'gitwt_deleted',
            rawActiveRootPath: undefined,
            persistedSurface: 'browse',
            resolveRouteHref: ({ activeRootPath, activeWorktreeId }) => `/projects/wr_1/files?root=${encodeURIComponent(activeRootPath)}&worktree=${activeWorktreeId ?? '@root'}`,
        }));

        expect(hook.getCurrent().resolvedActiveRootPath).toBe('/repo');
        expect(hook.getCurrent().resolvedActiveWorktreeId).toBeNull();

        await vi.waitFor(() => {
            expect(routerMock.spies.replace).toHaveBeenCalledWith('/projects/wr_1/files?root=%2Frepo&worktree=@root');
            expect(setLocalSettingSpies.projectLastActiveRootPathByWorkspaceRefId).toHaveBeenCalledWith({ wr_1: '/repo' });
            expect(setLocalSettingSpies.projectLastActiveWorktreeIdByWorkspaceRefId).toHaveBeenCalledWith({
                wr_1: '@root',
            });
        });

        await hook.unmount();
    });

    it('repairs a missing persisted worktree selection and exposes a recovery toast key', async () => {
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: {
                wr_1: '/repo/.worktrees/deleted-worktree',
            },
            projectLastActiveWorktreeIdByWorkspaceRefId: {
                wr_1: 'gitwt_deleted',
            },
        };
        projectLastMobileSurfaceMock = null;
        persistProjectLastMobileSurfaceSpy.mockClear();
        Object.values(setLocalSettingSpies).forEach((spy) => spy.mockClear());
        routerMock.state.router.setParams({});

        const { useProjectMobileRoutePersistence } = await import('./useProjectMobileRoutePersistence');
        const hook = await renderHook(() => useProjectMobileRoutePersistence({
            workspaceRef,
            isFocused: true,
            rawWorktreeId: undefined,
            rawActiveRootPath: undefined,
            persistedSurface: 'browse',
            resolveRouteHref: ({ activeRootPath, activeWorktreeId }) => `/projects/wr_1/files?root=${encodeURIComponent(activeRootPath)}&worktree=${activeWorktreeId ?? '@root'}`,
        }));

        expect(hook.getCurrent().resolvedActiveRootPath).toBe('/repo');
        expect(hook.getCurrent().recoveryToastKey).toBe('wr_1:/repo/.worktrees/deleted-worktree');

        await vi.waitFor(() => {
            expect(routerMock.spies.replace).toHaveBeenCalledWith('/projects/wr_1/files?root=%2Frepo&worktree=@root');
            expect(setLocalSettingSpies.projectLastActiveRootPathByWorkspaceRefId).toHaveBeenCalledWith({ wr_1: '/repo' });
        });

        await hook.unmount();
    });

    it('persists the cockpit-era mobile surface instead of the legacy route segment', async () => {
        localSettingsMock = {};
        projectLastMobileSurfaceMock = null;
        persistProjectLastMobileSurfaceSpy.mockClear();
        Object.values(setLocalSettingSpies).forEach((spy) => spy.mockClear());
        routerMock.state.router.setParams({});

        const { useProjectMobileRoutePersistence } = await import('./useProjectMobileRoutePersistence');
        const hook = await renderHook(() => useProjectMobileRoutePersistence({
            workspaceRef,
            isFocused: true,
            rawWorktreeId: undefined,
            rawActiveRootPath: undefined,
            persistedSurface: 'browse',
            resolveRouteHref: ({ activeRootPath, activeWorktreeId }) => `/projects/wr_1/files?root=${encodeURIComponent(activeRootPath)}&worktree=${activeWorktreeId ?? '@root'}`,
        }));

        await vi.waitFor(() => {
            expect(persistProjectLastMobileSurfaceSpy).toHaveBeenCalledWith('wr_1', 'browse');
        });

        await hook.unmount();
    });

    it('does not persist surface or canonicalize route params while the route is not focused', async () => {
        localSettingsMock = {};
        projectLastMobileSurfaceMock = null;
        persistProjectLastMobileSurfaceSpy.mockClear();
        Object.values(setLocalSettingSpies).forEach((spy) => spy.mockClear());
        routerMock.spies.replace.mockClear();
        routerMock.state.router.setParams({});

        const { useProjectMobileRoutePersistence } = await import('./useProjectMobileRoutePersistence');
        const hook = await renderHook(() => useProjectMobileRoutePersistence({
            workspaceRef,
            isFocused: false,
            rawWorktreeId: 'gitwt_deleted',
            rawActiveRootPath: undefined,
            persistedSurface: 'browse',
            resolveRouteHref: ({ activeRootPath, activeWorktreeId }) => `/projects/wr_1/files?root=${encodeURIComponent(activeRootPath)}&worktree=${activeWorktreeId ?? '@root'}`,
        }));

        expect(hook.getCurrent().resolvedActiveRootPath).toBe('/repo');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(routerMock.spies.replace).not.toHaveBeenCalled();
        expect(persistProjectLastMobileSurfaceSpy).not.toHaveBeenCalled();
        expect(setLocalSettingSpies.projectLastActiveRootPathByWorkspaceRefId).not.toHaveBeenCalled();
        expect(setLocalSettingSpies.projectLastActiveWorktreeIdByWorkspaceRefId).not.toHaveBeenCalled();

        await hook.unmount();
    });
});
