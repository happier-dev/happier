import { afterEach, expect, it, vi } from 'vitest';

import { act, renderHook } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { scmDiffCache } from '@/scm/diffCache/scmDiffCacheSingleton';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { useChangedFilesReviewPrefetch } from './useChangedFilesReviewPrefetch';
import type { ChangedFilesReviewRow } from './buildChangedFilesReviewRows';

// Network transport is the boundary; viewport demand, scheduling, acquisition,
// workspace routing, and cache freshness all execute their real implementations.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit');
    return createServerScopedMachineRpcBoundaryMock(vi.fn(async () => ({ success: true, diff: 'held diff' })));
});
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
    getActiveServerSnapshot: () => ({ serverId: 'server', serverUrl: 'https://example.com', generation: 1 }),
}));

const original = storage.getState();
const sessionId = 'prefetch-return-session';
const cacheSessionId = buildWorkspaceCacheKey({ serverId: 'server', machineId: 'm1', rootPath: '/repo' });
afterEach(() => {
    storage.setState({ settings: original.settings, sessions: original.sessions, machines: original.machines });
    scmDiffCache.invalidateSession(cacheSessionId);
    vi.clearAllMocks();
});

it('prefetches on viewport demand, without rereading its unmounted buffer on a snapshot-only return', async () => {
    const session = createSessionFixture();
    storage.setState({
        settings: { ...original.settings, scmReviewPrefetchAheadCountWeb: 4, scmReviewPrefetchAheadCountNative: 4,
            scmReviewPrefetchBehindCountWeb: 0, scmReviewPrefetchBehindCountNative: 0,
            scmReviewPrefetchDebounceMs: 0, scmReviewPrefetchConcurrency: 1 },
        sessions: { [sessionId]: { ...session, id: sessionId, metadata: { ...session.metadata!, machineId: 'm1', path: '/repo' } } },
        machines: { m1: createMachineFixture({ id: 'm1' }) },
    });
    const hook = await renderHook(({ signature }) => {
        // A new snapshot also publishes new row/status objects. Their identity
        // must not turn an unchanged viewport into fresh prefetch demand.
        const reviewFiles: ScmFileStatus[] = Array.from({ length: 10 }, (_, index) => ({
            fullPath: `row${index}.txt`, filePath: '', fileName: `row${index}.txt`,
            status: 'modified', isIncluded: false, linesAdded: 1, linesRemoved: 1,
        }));
        const rows: ChangedFilesReviewRow[] = reviewFiles.map((file, fileIndex) => ({
            kind: 'file', key: file.fullPath, sectionKey: 'pending', indexInSection: fileIndex, fileIndex, file,
        }));
        return useChangedFilesReviewPrefetch({ sessionId, snapshotSignature: signature, diffArea: 'pending', rows, reviewFiles,
            isCollapsed: () => false, normalizeError: String, fallbackError: 'failed' });
    }, { initialProps: { signature: 'first' } });
    try {
        const view = async (indices: number[]) => act(() => hook.getCurrent().onViewableItemsChanged({
            viewableItems: indices.map(index => ({ index })),
        }));
        await view([0, 1]);
        await vi.waitFor(() => expect(machineRpcWithServerScope).toHaveBeenCalledTimes(4));
        await hook.rerender({ signature: 'returned' });
        expect(machineRpcWithServerScope).toHaveBeenCalledTimes(4);
        await view([1, 2]);
        await vi.waitFor(() => expect(machineRpcWithServerScope).toHaveBeenCalledTimes(8));
        expect(vi.mocked(machineRpcWithServerScope).mock.calls.slice(4).map(([request]) =>
            (request.payload as { path: string }).path)).toEqual(['row3.txt', 'row4.txt', 'row5.txt', 'row6.txt']);
    } finally { await hook.unmount(); }
});
