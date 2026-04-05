import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = createExpoRouterMock();
let localSettingsMock: Record<string, unknown> = {};
const setLocalSettingSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => localSettingsMock[key],
        useLocalSettingMutable: () => [{}, setLocalSettingSpy],
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
    it('repairs a missing persisted worktree selection and exposes a recovery toast key', async () => {
        localSettingsMock = {
            projectLastActiveRootPathByWorkspaceRefId: {
                wr_1: '/repo/.worktrees/deleted-worktree',
            },
            projectLastActiveWorktreeIdByWorkspaceRefId: {
                wr_1: 'gitwt_deleted',
            },
        };
        setLocalSettingSpy.mockClear();
        routerMock.state.router.setParams({});

        const { useProjectMobileRoutePersistence } = await import('./useProjectMobileRoutePersistence');
        const hook = await renderHook(() => useProjectMobileRoutePersistence({
            workspaceRef,
            routeSegment: 'files',
            rawWorktreeId: undefined,
            rawActiveRootPath: undefined,
            persistedRouteSegment: 'files',
        }));

        expect(hook.getCurrent().resolvedActiveRootPath).toBe('/repo');
        expect(hook.getCurrent().recoveryToastKey).toBe('wr_1:/repo/.worktrees/deleted-worktree');

        await vi.waitFor(() => {
            expect(routerMock.spies.replace).toHaveBeenCalledWith('/projects/wr_1/files?worktreeId=%40root');
            expect(setLocalSettingSpy).toHaveBeenCalledWith({ wr_1: '/repo' });
        });

        await hook.unmount();
    });
});
