import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred, renderHook } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { loadWorkBoardSummariesWarmCache, saveWorkBoardSummariesWarmCache } from '@/sync/domains/state/warmCachePersistence';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import { usePinnedBoardRows } from './usePinnedBoardRows';

let heldList: Promise<void> | null = null;
const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
// Real Account, Artifact store and Board owners run; only the Home HTTP boundary is held.
const runtime = installSessionPaneRuntimeTestHarness({
    request: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === '/v1/artifacts' && (init?.method ?? 'GET') === 'GET' && heldList) await heldList;
        return await artifacts.handle(`${url.pathname}${url.search}`, init);
    },
});

describe('Boards pinned to the Sessions column', () => {
    // The device warm cache (MMKV, a platform boundary stubbed in memory) opens once its key is resolved.
    beforeAll(async () => { await prepareWarmCacheEncryptionKey(); });

    it('draws the rows this device last saw in the first paint, so the list header does not move when the inventory returns', async () => {
        saveWorkBoardSummariesWarmCache(runtime.serverId, 'account-a', { boards: [
            { id: 'release', name: 'Release board', pinnedInSessions: true, readsNeedsYou: false },
            { id: 'quiet', name: 'Quiet board', pinnedInSessions: false, readsNeedsYou: false },
        ] });
        const list = createDeferred<void>();
        heldList = list.promise;
        const hook = await renderHook(() => usePinnedBoardRows(true), { wrapper: runtime.Wrapper });
        try {
            // Before the Board inventory settles, the column already holds its pinned row.
            expect(hook.getCurrent().rows.map(row => row.title)).toEqual(['Release board']);
            // The read is authoritative: the Home has no such Board any more, so the row leaves.
            await act(async () => { list.resolve(); });
            await vi.waitFor(() => expect(hook.getCurrent().rows).toEqual([]));
        } finally {
            heldList = null;
            list.resolve();
            await hook.unmount();
        }
    });

    it('remembers the settled Board headers for the next launch', async () => {
        const executor = createDefaultActionExecutor();
        const created = await executor.execute('boards.apply', { intent: { kind: 'create', board: { id: '22222222-2222-4222-8222-222222222223', name: 'Pinned board' } } },
            { serverId: runtime.serverId, surface: 'ui', bypassApprovals: true });
        expect(created).toMatchObject({ ok: true });
        const pinned = await executor.execute('boards.apply', { intent: { kind: 'update', boardId: '22222222-2222-4222-8222-222222222223', patch: { pinnedInSessions: true } } },
            { serverId: runtime.serverId, surface: 'ui', bypassApprovals: true });
        expect(pinned).toMatchObject({ ok: true });
        const hook = await renderHook(() => usePinnedBoardRows(true), { wrapper: runtime.Wrapper });
        try {
            await vi.waitFor(() => expect(hook.getCurrent().rows.map(row => row.title)).toEqual(['Pinned board']));
            expect(loadWorkBoardSummariesWarmCache(runtime.serverId, 'account-a')?.boards)
                .toEqual([{ id: '22222222-2222-4222-8222-222222222223', name: 'Pinned board', pinnedInSessions: true, readsNeedsYou: false }]);
        } finally {
            await hook.unmount();
        }
    });
});
