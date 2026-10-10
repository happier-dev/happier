import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

// Expo navigation is the boundary; page and qualified route decisions remain real.
const routerMock = createExpoRouterMock({ pathname: '/projects/wr_1/context', params: {
    workspaceRefId: 'wr_1', serverId: 'server-1', layoutId: 'selected',
    comparisonId: 'comparison-a', initialFile: 'a.ts' } });
vi.mock('expo-router', () => routerMock.module);
const workspaceRef: WorkspaceRefV1 = { id: 'wr_1', serverId: 'server-1', machineId: 'machine-1',
    rootPath: '/repo', label: 'Project Alpha', createdAtMs: 1, lastOpenedAtMs: null };
describe('project route actions', () => {
    beforeEach(() => { routerMock.spies.push.mockClear(); routerMock.spies.replace.mockClear(); });
    it('changes pages without dropping qualified dashboard, comparison, and file intent', async () => {
        const { useProjectRouteActions } = await import('./useProjectRouteActions');
        const hook = await renderHook(() => useProjectRouteActions({ workspaceRef,
            activeRootPath: '/repo/feature', activeWorktreeId: 'checkout-a' }));
        hook.getCurrent().navigateToSegment({ segment: 'changes', method: 'push' });
        const href = routerMock.spies.push.mock.calls[0][0];
        expect(typeof href).toBe('string');
        const url = new URL(String(href), 'https://happier.test');
        expect(url.pathname).toBe('/projects/wr_1/changes');
        expect(Object.fromEntries(url.searchParams)).toEqual({ serverId: 'server-1', layoutId: 'selected',
            comparisonId: 'comparison-a', initialFile: 'a.ts', worktreeId: 'checkout-a' });
        hook.getCurrent().navigateToSegment({ workspaceRef: { ...workspaceRef, id: 'wr_2', rootPath: '/other/repo' } });
        const checkout = new URL(String(routerMock.spies.push.mock.calls[1][0]), 'https://happier.test');
        expect(checkout.pathname).toBe('/projects/wr_2/context');
        expect(Object.fromEntries(checkout.searchParams)).toEqual({ serverId: 'server-1', layoutId: 'selected',
            comparisonId: 'comparison-a', initialFile: 'a.ts', worktreeId: '@root' });
        await hook.unmount();
    });
});
