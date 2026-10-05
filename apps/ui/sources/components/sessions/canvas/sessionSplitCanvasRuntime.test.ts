import { afterEach, describe, expect, it, vi } from 'vitest';

function createRuntimeSnapshot(routeSessionId: string) {
    return {
        routeSessionId,
        focusedSessionId: routeSessionId,
        openSessionIds: [routeSessionId],
        entityScope: { serverId: 'server-a', accountId: 'account-a' },
        canvasKey: 'server-a:machine-1:/repo',
        scope: {
            workspaceCacheKey: 'server-a:machine-1:/repo',
            serverId: 'server-a',
            machineId: 'machine-1',
            rootPath: '/repo',
        },
    } as const;
}

describe('sessionSplitCanvasRuntime', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.resetModules();
    });

    it('defers unregister notifications until the next task so deleted-tree unmounts are not notified in the same turn', async () => {
        vi.useFakeTimers();
        const runtime = await import('./sessionSplitCanvasRuntime');
        const listener = vi.fn();
        const unsubscribe = runtime.subscribeSessionSplitCanvasRuntime(listener);
        const unregister = runtime.registerSessionSplitCanvasRuntime({
            snapshot: createRuntimeSnapshot('sess_a'),
            controller: {
                executeAction: () => ({ status: 'unavailable' }),
                focusSession: () => undefined,
                openSessionInSplit: () => undefined,
            },
        });

        expect(listener).toHaveBeenCalledTimes(1);
        listener.mockClear();

        unregister();
        await Promise.resolve();

        expect(listener).not.toHaveBeenCalled();
        expect(runtime.getSessionSplitCanvasRuntimeController()).toBeNull();
        expect(runtime.getSessionSplitCanvasRuntimeSnapshot()).toEqual(createRuntimeSnapshot('sess_a'));

        await vi.runAllTimersAsync();

        expect(listener).toHaveBeenCalledTimes(1);
        expect(runtime.getSessionSplitCanvasRuntimeSnapshot()).toEqual({
            routeSessionId: null,
            focusedSessionId: null,
            openSessionIds: [],
            scope: null,
            entityScope: null,
            canvasKey: null,
        });

        unsubscribe();
    });
});
