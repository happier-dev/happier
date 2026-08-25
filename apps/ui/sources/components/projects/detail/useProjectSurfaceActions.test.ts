import { describe, expect, it, vi, beforeEach } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = createExpoRouterMock();
const openDetailsTabMock = vi.hoisted(() => vi.fn());
const getWorkspaceRepositoryTreeExpandedPathsMock = vi.hoisted(() => vi.fn(() => []));
const setWorkspaceRepositoryTreeExpandedPathsMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openDetailsTab: openDetailsTabMock,
    }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: () => ({
                getWorkspaceRepositoryTreeExpandedPaths: getWorkspaceRepositoryTreeExpandedPathsMock,
                setWorkspaceRepositoryTreeExpandedPaths: setWorkspaceRepositoryTreeExpandedPathsMock,
            }),
        },
    });
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

const workspaceRef: WorkspaceRefV1 = {
    id: 'wr_1',
    serverId: 'server-1',
    machineId: 'machine-1',
    rootPath: '/repo',
    label: 'Project Alpha',
    createdAtMs: 1,
    lastOpenedAtMs: null,
};

describe('useProjectSurfaceActions', () => {
    beforeEach(() => {
        routerMock.spies.push.mockClear();
        openDetailsTabMock.mockClear();
        getWorkspaceRepositoryTreeExpandedPathsMock.mockClear();
        setWorkspaceRepositoryTreeExpandedPathsMock.mockClear();
    });

    it('opens create-worktree new-session flow with the workspace spawn server scope', async () => {
        const { useProjectSurfaceActions } = await import('./useProjectSurfaceActions');
        const hook = await renderHook(() => useProjectSurfaceActions({
            scopeId: 'project:wr_1',
            workspaceRef,
            activeRootPath: '/repo/.worktrees/feature-auth',
        }));

        hook.getCurrent().openCreateWorktreeFlow();

        expect(routerMock.spies.push).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                machineId: 'machine-1',
                directory: '/repo/.worktrees/feature-auth',
                worktree: 'new',
                spawnServerId: 'server-1',
            },
        });

        await hook.unmount();
    });
});
