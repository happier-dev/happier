import { describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

const useSessionWorkspaceTargetSpy = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/session/useSessionWorkspaceTarget', () => ({
    useSessionWorkspaceTarget: (sessionId: string | null) => useSessionWorkspaceTargetSpy(sessionId),
}));

describe('useSessionCanvasEligibility', () => {
    it('returns a normalized canvas scope when the session has a workspace target', async () => {
        useSessionWorkspaceTargetSpy.mockReturnValue({
            workspaceCacheKey: 'stale',
            serverId: ' server-a ',
            machineId: ' machine-1 ',
            rootPath: '/repo//nested',
        });

        const { useSessionCanvasEligibility } = await import('./useSessionCanvasEligibility');
        const hook = await renderHook(() => useSessionCanvasEligibility('sess_1'));

        expect(hook.getCurrent()).toEqual({
            isCanvasEligible: true,
            reason: 'eligible',
            scope: {
                workspaceCacheKey: 'server-a:machine-1:/repo/nested',
                serverId: 'server-a',
                machineId: 'machine-1',
                rootPath: '/repo/nested',
            },
        });

        await hook.unmount();
    });

    it('rebases the canvas scope onto the route server id when the route is explicitly server-scoped', async () => {
        useSessionWorkspaceTargetSpy.mockReturnValue({
            workspaceCacheKey: 'stale',
            serverId: 'server-a',
            machineId: 'machine-1',
            rootPath: '/repo',
        });

        const { useSessionCanvasEligibility } = await import('./useSessionCanvasEligibility');
        const hook = await renderHook(() => useSessionCanvasEligibility('sess_1', {
            routeServerId: ' server-route ',
        }));

        expect(hook.getCurrent()).toEqual({
            isCanvasEligible: true,
            reason: 'eligible',
            scope: {
                workspaceCacheKey: 'server-route:machine-1:/repo',
                serverId: 'server-route',
                machineId: 'machine-1',
                rootPath: '/repo',
            },
        });

        await hook.unmount();
    });

    it('preserves the resolved scope identity when the route server id is semantically unchanged', async () => {
        const workspaceTarget = {
            workspaceCacheKey: 'stale',
            serverId: 'server-a',
            machineId: 'machine-1',
            rootPath: '/repo',
        };
        useSessionWorkspaceTargetSpy.mockReturnValue(workspaceTarget);

        const { useSessionCanvasEligibility } = await import('./useSessionCanvasEligibility');
        const hook = await renderHook((props: {
            routeServerId?: string | null;
        }) => useSessionCanvasEligibility('sess_1', {
            routeServerId: props.routeServerId,
        }), {
            initialProps: {
                routeServerId: ' server-route ',
            },
        });

        const initialResult = hook.getCurrent();

        await hook.rerender({
            routeServerId: 'server-route',
        });

        expect(hook.getCurrent()).toBe(initialResult);
        expect(hook.getCurrent().scope).toBe(initialResult.scope);

        await hook.unmount();
    });

    it('reports that the session is not yet canvas-eligible when no workspace target exists', async () => {
        useSessionWorkspaceTargetSpy.mockReturnValue(null);

        const { useSessionCanvasEligibility } = await import('./useSessionCanvasEligibility');
        const hook = await renderHook(() => useSessionCanvasEligibility('sess_2'));

        expect(hook.getCurrent()).toEqual({
            isCanvasEligible: false,
            reason: 'workspace-unavailable',
            scope: null,
        });

        await hook.unmount();
    });
});
