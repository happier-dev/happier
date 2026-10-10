import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const listWorkspaceSyncConflicts = vi.hoisted(() => vi.fn());

// The daemon response is the boundary; conflict request and page parsing stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: async (input: Readonly<{
        serverId?: string | null; machineId: string; method: string;
        payload: Readonly<{ relationshipId: string; cursor?: string }>;
    }>) => {
        if (input.method !== RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST) {
            throw new Error(`Unexpected RPC: ${input.method}`);
        }
        return await listWorkspaceSyncConflicts({
            ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
            controllerMachineId: input.machineId, relationshipId: input.payload.relationshipId,
            ...(input.payload.cursor ? { cursor: input.payload.cursor } : {}),
        });
    },
}));

import {
    getWorkspaceSyncConflictSnapshot,
    invalidateWorkspaceSyncConflicts,
    loadMoreWorkspaceSyncConflicts,
    refreshWorkspaceSyncConflicts,
    resetWorkspaceSyncConflictStoreForTests,
} from './workspaceSyncConflictStore';
import { applyWorkspaceSyncRuntimeEvent } from './applyWorkspaceSyncRuntimeEvent';

describe('workspaceSyncConflictStore', () => {
    beforeEach(() => {
        listWorkspaceSyncConflicts.mockReset();
        resetWorkspaceSyncConflictStoreForTests();
    });

    it('coalesces conflict reads and preserves the daemon truncation facts', async () => {
        const scope = { relationshipId: 'relationship-1', controllerMachineId: 'machine-1' } as const;
        listWorkspaceSyncConflicts.mockResolvedValueOnce({
            status: 'page',
            relationshipId: 'relationship-1',
            totalCount: 2,
            nextCursor: 'next-page',
            conflicts: [{
                relationshipId: 'relationship-1',
                path: 'file.txt',
                alpha: { kind: 'file', digest: 'a'.repeat(40) },
                beta: { kind: 'file', digest: 'b'.repeat(40) },
            }],
        });

        await Promise.all([
            refreshWorkspaceSyncConflicts(scope),
            refreshWorkspaceSyncConflicts(scope),
        ]);

        expect(listWorkspaceSyncConflicts).toHaveBeenCalledTimes(1);
        expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({
            phase: 'ready',
            list: { totalCount: 2, shownCount: 1, truncatedCount: 1 },
            nextCursor: 'next-page',
            hasMore: true,
            invalidated: false,
        });
    });

    it('appends public cursor pages and preserves loaded conflicts when the engine invalidates the cursor', async () => {
        const scope = { relationshipId: 'relationship-1', controllerMachineId: 'machine-1' } as const;
        listWorkspaceSyncConflicts
            .mockResolvedValueOnce({
                status: 'page', relationshipId: 'relationship-1', totalCount: 2, nextCursor: 'next-page',
                conflicts: [{ relationshipId: 'relationship-1', path: 'a.txt', alpha: { kind: 'file' }, beta: { kind: 'file' } }],
            })
            .mockResolvedValueOnce({ status: 'cursor_invalidated', relationshipId: 'relationship-1' });

        await refreshWorkspaceSyncConflicts(scope);
        await loadMoreWorkspaceSyncConflicts(scope);

        expect(listWorkspaceSyncConflicts).toHaveBeenNthCalledWith(2, {
            ...scope,
            cursor: 'next-page',
        });
        expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({
            phase: 'invalidated',
            list: { totalCount: 2, shownCount: 1, conflicts: [{ path: 'a.txt' }] },
            hasMore: false,
            invalidated: true,
        });
    });

    it('refreshes an observed conflict list after a controller status event and preserves the last-known list', async () => {
        const scope = { serverId: 'server-1', relationshipId: 'relationship-1', controllerMachineId: 'machine-1' } as const;
        listWorkspaceSyncConflicts
            .mockResolvedValueOnce({ status: 'page', relationshipId: 'relationship-1', totalCount: 1, nextCursor: null, conflicts: [] })
            .mockResolvedValueOnce({ status: 'page', relationshipId: 'relationship-1', totalCount: 0, nextCursor: null, conflicts: [] });
        await refreshWorkspaceSyncConflicts(scope);
        const unsubscribe = (await import('./workspaceSyncConflictStore')).subscribeWorkspaceSyncConflicts(scope, () => {});

        invalidateWorkspaceSyncConflicts(scope);
        expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({
            phase: 'refreshing',
            list: { totalCount: 1 },
        });
        await vi.waitFor(() => expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({
            phase: 'ready',
            list: { totalCount: 0 },
        }));
        expect(listWorkspaceSyncConflicts).toHaveBeenCalledTimes(2);
        unsubscribe();
    });

    it('invalidates only the demanded admitted conflict scopes when Machine readiness is republished', async () => {
        const scope = { serverId: 'server-1', relationshipId: 'private-relationship', controllerMachineId: 'machine-1' };
        const other = { ...scope, serverId: 'server-2' };
        listWorkspaceSyncConflicts
            .mockResolvedValueOnce({ status: 'page', relationshipId: scope.relationshipId, totalCount: 1, nextCursor: 'old', conflicts: [] })
            .mockResolvedValueOnce({ status: 'page', relationshipId: scope.relationshipId, totalCount: 2, nextCursor: null, conflicts: [] })
            .mockResolvedValueOnce({ status: 'page', relationshipId: scope.relationshipId, totalCount: 0, nextCursor: null, conflicts: [] });
        await refreshWorkspaceSyncConflicts(scope);
        await refreshWorkspaceSyncConflicts(other);
        const { subscribeWorkspaceSyncConflicts } = await import('./workspaceSyncConflictStore');
        const unsubscribe = subscribeWorkspaceSyncConflicts(scope, () => {});
        applyWorkspaceSyncRuntimeEvent({ serverId: scope.serverId, machineId: scope.controllerMachineId,
            event: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } } } });
        await vi.waitFor(() => expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({
            phase: 'ready', list: { totalCount: 0 }, nextCursor: null,
        }));
        expect(getWorkspaceSyncConflictSnapshot(other)).toMatchObject({ phase: 'ready', list: { totalCount: 2 } });
        expect(listWorkspaceSyncConflicts).toHaveBeenCalledTimes(3);
        unsubscribe();
    });

    it('preserves an unobserved conflict page as stale without fetching it', async () => {
        const scope = { serverId: 'server-1', relationshipId: 'relationship-1', controllerMachineId: 'machine-1' };
        listWorkspaceSyncConflicts.mockResolvedValueOnce({ status: 'page', relationshipId: scope.relationshipId,
            totalCount: 1, nextCursor: 'old-cursor',
            conflicts: [{ relationshipId: scope.relationshipId, path: 'known.txt', alpha: { kind: 'file' }, beta: { kind: 'file' } }] });
        await refreshWorkspaceSyncConflicts(scope);
        applyWorkspaceSyncRuntimeEvent({ serverId: scope.serverId, machineId: scope.controllerMachineId,
            event: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } } } });
        expect(listWorkspaceSyncConflicts).toHaveBeenCalledOnce();
        expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({ phase: 'idle',
            list: { conflicts: [{ path: 'known.txt' }] } });
        listWorkspaceSyncConflicts.mockImplementationOnce(() => new Promise(() => {}));
        void refreshWorkspaceSyncConflicts(scope);
        expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({ phase: 'refreshing',
            list: { conflicts: [{ path: 'known.txt' }] } });
    });

    it('rejects an in-flight page invalidated by a runtime event and refreshes observers from the first page', async () => {
        let resolveStalePage!: (value: unknown) => void;
        const scope = { serverId: 'server-1', relationshipId: 'relationship-1', controllerMachineId: 'machine-1' } as const;
        listWorkspaceSyncConflicts
            .mockResolvedValueOnce({
                status: 'page', relationshipId: 'relationship-1', totalCount: 1, nextCursor: null,
                conflicts: [{ relationshipId: 'relationship-1', path: 'known.txt', alpha: { kind: 'file' }, beta: { kind: 'file' } }],
            })
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveStalePage = resolve;
            }))
            .mockResolvedValueOnce({
                status: 'page', relationshipId: 'relationship-1', totalCount: 1, nextCursor: null,
                conflicts: [{ relationshipId: 'relationship-1', path: 'fresh.txt', alpha: { kind: 'file' }, beta: { kind: 'file' } }],
            });
        await refreshWorkspaceSyncConflicts(scope);
        const observedReadyPaths: string[][] = [];
        const unsubscribe = (await import('./workspaceSyncConflictStore')).subscribeWorkspaceSyncConflicts(scope, () => {
            const snapshot = getWorkspaceSyncConflictSnapshot(scope);
            if (snapshot.phase === 'ready') {
                observedReadyPaths.push(snapshot.list?.conflicts.map((conflict) => conflict.path) ?? []);
            }
        });

        const staleRefresh = refreshWorkspaceSyncConflicts(scope);
        invalidateWorkspaceSyncConflicts(scope);
        resolveStalePage({
            status: 'page', relationshipId: 'relationship-1', totalCount: 1, nextCursor: null,
            conflicts: [{ relationshipId: 'relationship-1', path: 'stale.txt', alpha: { kind: 'file' }, beta: { kind: 'file' } }],
        });
        await staleRefresh;
        await vi.waitFor(() => expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({
            phase: 'ready',
            list: { conflicts: [{ path: 'fresh.txt' }] },
        }));

        expect(observedReadyPaths).not.toContainEqual(['stale.txt']);
        expect(listWorkspaceSyncConflicts).toHaveBeenCalledTimes(3);
        expect(listWorkspaceSyncConflicts).toHaveBeenNthCalledWith(3, scope);
        unsubscribe();
    });
});
