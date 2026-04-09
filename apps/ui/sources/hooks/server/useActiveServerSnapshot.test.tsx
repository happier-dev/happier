import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';

const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn());
const subscribeActiveServerMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: getActiveServerSnapshotMock,
    subscribeActiveServer: subscribeActiveServerMock,
}));

describe('useActiveServerSnapshot', () => {
    beforeEach(() => {
        getActiveServerSnapshotMock.mockReset();
        subscribeActiveServerMock.mockReset();
        subscribeActiveServerMock.mockImplementation(() => () => {});
    });

    it('reads the latest active server snapshot on mount even if it changed before the subscription effect attached', async () => {
        let currentSnapshot = { serverId: 'server-a', serverUrl: 'http://api.example.test', generation: 1 };
        getActiveServerSnapshotMock.mockImplementation(() => currentSnapshot);
        subscribeActiveServerMock.mockImplementationOnce(() => {
            currentSnapshot = { serverId: 'server-b', serverUrl: 'http://api.override.test', generation: 2 };
            return () => {};
        });

        const { useActiveServerSnapshot } = await import('./useActiveServerSnapshot');
        const hook = await renderHook(() => useActiveServerSnapshot());

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent()).toEqual(currentSnapshot);
    });
});
