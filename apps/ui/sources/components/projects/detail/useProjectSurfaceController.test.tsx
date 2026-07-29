import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const routerMock = createExpoRouterMock();
const paneScopeMock = {
    openRight: vi.fn(),
    setRightTab: vi.fn(),
    closeRight: vi.fn(),
    scopeState: {
        right: {
            isOpen: false,
            activeTabId: null as string | null,
        },
    },
};

vi.mock('expo-router', () => routerMock.module);

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => paneScopeMock,
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

describe('useProjectSurfaceController', () => {
    beforeEach(() => {
        paneScopeMock.openRight.mockClear();
        paneScopeMock.setRightTab.mockClear();
        routerMock.spies.replace.mockClear();
    });

    it('preserves a non-worktree active root path when changing cockpit surfaces on phone', async () => {
        const { useProjectSurfaceController } = await import('./useProjectSurfaceController');
        const hook = await renderHook(() => useProjectSurfaceController({
            scopeId: 'project:wr_1',
            workspaceRef,
            activeRootPath: '/repo/packages/ui',
            activeWorktreeId: null,
        }));

        hook.getCurrent().setActiveTab('services');

        expect(routerMock.spies.replace).toHaveBeenCalledWith(
            '/projects/wr_1?activeRootPath=%2Frepo%2Fpackages%2Fui&mobileSurface=services',
        );

        await hook.unmount();
    });
});
