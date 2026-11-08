import { afterEach, describe, expect, it } from 'vitest';
import { createScmCapabilities, ScmWorkingSnapshotSchema } from '@happier-dev/protocol/scm';

import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { readScmEntriesPageSize } from '@/scm/refresh/scmEntriesDemand';
import { useWorkspaceScmSlotLacksList, useWorkspaceScmSnapshot } from './scmHooks';

describe('workspace SCM list consumption', () => {
    const scope = { serverId: 'paged-hook-home', machineId: 'paged-hook-machine', rootPath: '/repo' };
    const slot = { kind: 'workspace' as const, scope };
    const full = ScmWorkingSnapshotSchema.parse({
        projectKey: 'paged-hook-machine:/repo', fetchedAt: 1,
        repo: { isRepo: true, rootPath: scope.rootPath, backendId: 'git', mode: '.git' },
        capabilities: createScmCapabilities({ readStatus: true }),
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        hasConflicts: false,
        entries: [{ path: 'held.txt', previousPath: null, kind: 'untracked', includeStatus: '?', pendingStatus: '?',
            hasIncludedDelta: false, hasPendingDelta: true,
            stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0, isBinary: false } }],
        totals: { includedFiles: 0, pendingFiles: 1, untrackedFiles: 1,
            includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
    });
    const page: ScmWorkingSnapshot = { ...full, entries: [{ ...full.entries[0]!, path: 'page.txt' }],
        entriesPage: { totalFiles: 54_935, nextCursor: 1 } };

    afterEach(() => {
        standardCleanup();
        storage.getState().updateWorkspaceScmSnapshot(scope, null);
    });

    it('lets a viewport consume a page while a full consumer keeps its held rows until completion', async () => {
        storage.getState().updateWorkspaceScmSnapshot(scope, full);
        const complete = await renderHook(() => ({ snapshot: useWorkspaceScmSnapshot(scope), lacks: useWorkspaceScmSlotLacksList(scope) }));
        await act(async () => { storage.getState().updateWorkspaceScmSnapshot(scope, page); });
        expect(complete.getCurrent().snapshot?.entries[0]?.path).toBe('held.txt');
        expect(complete.getCurrent().lacks).toBe(true);
        const limited = await renderHook(() => ({ snapshot: useWorkspaceScmSnapshot(scope, 20), lacks: useWorkspaceScmSlotLacksList(scope, 20) }));
        expect(limited.getCurrent().snapshot?.entries[0]?.path).toBe('page.txt');
        expect(limited.getCurrent().lacks).toBe(false);
        expect(readScmEntriesPageSize(slot)).toBeUndefined();
        await complete.unmount();
        expect(readScmEntriesPageSize(slot)).toBe(20);
        await act(async () => { storage.getState().updateWorkspaceScmSnapshot(scope, { ...page, entriesPage: { totalFiles: 1, nextCursor: null } }); });
        const coldFull = await renderHook(() => useWorkspaceScmSnapshot(scope));
        expect(coldFull.getCurrent()?.entries[0]?.path).toBe('page.txt');
        await coldFull.unmount();
        await limited.unmount();
    });

    it('does not present an incomplete page as a full list on cold mount', async () => {
        storage.getState().updateWorkspaceScmSnapshot(scope, page);
        let pageSize: number | undefined;
        const hook = await renderHook(() => useWorkspaceScmSnapshot(scope, pageSize));
        expect(hook.getCurrent()).toBeNull();
        pageSize = 20;
        await hook.rerender();
        expect(hook.getCurrent()?.entries[0]?.path).toBe('page.txt');
        pageSize = undefined;
        await hook.rerender();
        expect(hook.getCurrent()).toBeNull();
        await hook.unmount();
    });
});
