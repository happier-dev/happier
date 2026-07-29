import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = createExpoRouterMock();

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useSetting: (key: string) => key === 'mobileWorkspaceExperienceV1' ? 'classic' : null,
    });
});

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
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

describe('useProjectRouteActions', () => {
    beforeEach(() => {
        routerMock.spies.push.mockClear();
        routerMock.spies.replace.mockClear();
    });

    it('preserves hosted browser surface context when pushing the fullscreen details route', async () => {
        const { useProjectRouteActions } = await import('./useProjectRouteActions');
        const hook = await renderHook(() => useProjectRouteActions({
            workspaceRef,
            activeRootPath: '/repo',
            activeWorktreeId: null,
        }));

        hook.getCurrent().navigateToSegment({
            segment: 'details',
            method: 'push',
            sourceSurface: 'browser',
        });

        expect(routerMock.spies.push).toHaveBeenCalledWith(
            '/projects/wr_1/details?worktreeId=%40root&sourceSurface=browser',
        );

        await hook.unmount();
    });
});
