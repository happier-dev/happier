import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createWorkspaceSyncHarness } from '@/dev/testkit/harness/workspaceSyncHarness';

const listWorkspaceSyncConflicts = vi.hoisted(() => vi.fn());
const conflictReadHomeOrigins: string[] = [];

// The daemon's Socket.IO reply is the boundary; scoped RPC, conflict request and page parsing stay real.
// A call records the daemon-visible scope; the Home each read reached is recorded separately.
const workspace = createWorkspaceSyncHarness(async input => {
    if (input.method !== RPC_METHODS.DAEMON_WORKSPACE_SYNC_CONFLICTS_LIST) {
        throw new Error(`Unexpected RPC: ${input.method}`);
    }
    conflictReadHomeOrigins.push(input.serverUrl ? new URL(input.serverUrl).origin : 'unknown');
    const payload = input.payload as Readonly<{ relationshipId: string; cursor?: string }>;
    return await listWorkspaceSyncConflicts({
        controllerMachineId: input.machineId, relationshipId: payload.relationshipId,
        ...(payload.cursor ? { cursor: payload.cursor } : {}),
    });
});
await workspace.ready;

const {
    getWorkspaceSyncConflictSnapshot,
    invalidateWorkspaceSyncConflicts,
    loadMoreWorkspaceSyncConflicts,
    refreshWorkspaceSyncConflicts,
    resetWorkspaceSyncConflictStoreForTests,
    subscribeWorkspaceSyncConflicts,
} = await import('./workspaceSyncConflictStore');
const { applyWorkspaceSyncRuntimeEvent } = await import('./applyWorkspaceSyncRuntimeEvent');

describe('workspaceSyncConflictStore', () => {
    beforeEach(async () => {
        await workspace.reset();
        listWorkspaceSyncConflicts.mockReset();
        conflictReadHomeOrigins.length = 0;
        resetWorkspaceSyncConflictStoreForTests();
    });

    afterEach(async () => {
        resetWorkspaceSyncConflictStoreForTests();
        await workspace.dispose();
    });

    it('coalesces conflict reads and preserves the daemon truncation facts', async () => {
        const scope = { serverId: workspace.serverId, relationshipId: 'relationship-1', controllerMachineId: 'machine-a' } as const;
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

    it('retains an idle conflict snapshot across repeated unobserved invalidations', () => {
        const scope = { serverId: workspace.serverId, relationshipId: 'relationship-1', controllerMachineId: 'machine-a' };
        const initial = getWorkspaceSyncConflictSnapshot(scope);
        invalidateWorkspaceSyncConflicts(scope);
        invalidateWorkspaceSyncConflicts(scope);
        expect(getWorkspaceSyncConflictSnapshot(scope)).toBe(initial);
        expect(listWorkspaceSyncConflicts).not.toHaveBeenCalled();
    });

    it('retains equal lists and unchanged rows while publishing refresh, cursor, and content transitions', async () => {
        const scope = { serverId: workspace.serverId, relationshipId: 'relationship-1', controllerMachineId: 'machine-a' };
        const page = { status: 'page', relationshipId: scope.relationshipId, totalCount: 2, nextCursor: 'next',
            conflicts: [
                { relationshipId: scope.relationshipId, path: 'a.txt', alpha: { kind: 'file' }, beta: { kind: 'file' } },
                { relationshipId: scope.relationshipId, path: 'b.txt', alpha: { kind: 'file' }, beta: { kind: 'file' } },
            ] };
        listWorkspaceSyncConflicts.mockResolvedValueOnce(page).mockResolvedValueOnce(page)
            .mockResolvedValueOnce({ ...page, nextCursor: null, conflicts: [page.conflicts[0],
                { ...page.conflicts[1], beta: { kind: 'missing' } }] });
        await refreshWorkspaceSyncConflicts(scope);
        const initial = getWorkspaceSyncConflictSnapshot(scope);
        const listener = vi.fn();
        subscribeWorkspaceSyncConflicts(scope, listener);
        const equal = refreshWorkspaceSyncConflicts(scope);
        expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({ phase: 'refreshing' });
        expect(getWorkspaceSyncConflictSnapshot(scope).list).toBe(initial.list);
        expect(await equal).toBe(initial.list);
        expect(getWorkspaceSyncConflictSnapshot(scope).list).toBe(initial.list);
        expect(listener).toHaveBeenCalledTimes(2);
        await refreshWorkspaceSyncConflicts(scope);
        const changed = getWorkspaceSyncConflictSnapshot(scope);
        expect(changed).toMatchObject({ phase: 'ready', nextCursor: null, hasMore: false });
        expect(changed.list?.conflicts[0]).toBe(initial.list?.conflicts[0]);
        expect(changed.list?.conflicts[1]).not.toBe(initial.list?.conflicts[1]);
        expect(changed.list?.conflicts[1]?.beta.kind).toBe('missing');
        expect(listener).toHaveBeenCalledTimes(4);
    });

    it('appends public cursor pages and preserves loaded conflicts when the engine invalidates the cursor', async () => {
        const scope = { serverId: workspace.serverId, relationshipId: 'relationship-1', controllerMachineId: 'machine-a' } as const;
        listWorkspaceSyncConflicts
            .mockResolvedValueOnce({
                status: 'page', relationshipId: 'relationship-1', totalCount: 2, nextCursor: 'next-page',
                conflicts: [{ relationshipId: 'relationship-1', path: 'a.txt', alpha: { kind: 'file' }, beta: { kind: 'file' } }],
            })
            .mockResolvedValueOnce({ status: 'cursor_invalidated', relationshipId: 'relationship-1' });

        await refreshWorkspaceSyncConflicts(scope);
        await loadMoreWorkspaceSyncConflicts(scope);

        expect(listWorkspaceSyncConflicts).toHaveBeenNthCalledWith(2, {
            relationshipId: scope.relationshipId,
            controllerMachineId: scope.controllerMachineId,
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
        const scope = { serverId: workspace.serverId, relationshipId: 'relationship-1', controllerMachineId: 'machine-a' } as const;
        listWorkspaceSyncConflicts
            .mockResolvedValueOnce({ status: 'page', relationshipId: 'relationship-1', totalCount: 1, nextCursor: null, conflicts: [] })
            .mockResolvedValueOnce({ status: 'page', relationshipId: 'relationship-1', totalCount: 0, nextCursor: null, conflicts: [] });
        await refreshWorkspaceSyncConflicts(scope);
        const unsubscribe = subscribeWorkspaceSyncConflicts(scope, () => {});

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
        const scope = { serverId: workspace.serverId, relationshipId: 'private-relationship', controllerMachineId: 'machine-a' };
        const otherServerId = await workspace.home.addHome({ name: 'Other Home', serverUrl: 'https://other-workspace.test',
            accountId: workspace.accountId });
        workspace.home.answer(otherServerId, '/v1/machines/machine-a', {
            body: { machine: createPlainMachineRowFixture({ id: 'machine-a', accountId: workspace.accountId }) } });
        const other = { ...scope, serverId: otherServerId };
        listWorkspaceSyncConflicts
            .mockResolvedValueOnce({ status: 'page', relationshipId: scope.relationshipId, totalCount: 1, nextCursor: 'old', conflicts: [] })
            .mockResolvedValueOnce({ status: 'page', relationshipId: scope.relationshipId, totalCount: 2, nextCursor: null, conflicts: [] })
            .mockResolvedValueOnce({ status: 'page', relationshipId: scope.relationshipId, totalCount: 0, nextCursor: null, conflicts: [] });
        await refreshWorkspaceSyncConflicts(scope);
        await refreshWorkspaceSyncConflicts(other);
        const unsubscribe = subscribeWorkspaceSyncConflicts(scope, () => {});
        applyWorkspaceSyncRuntimeEvent({ serverId: scope.serverId, machineId: scope.controllerMachineId,
            event: { v: 1, readiness: { engine: { state: 'ready' }, carrier: { state: 'ready' } } } });
        await vi.waitFor(() => expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({
            phase: 'ready', list: { totalCount: 0 }, nextCursor: null,
        }));
        expect(getWorkspaceSyncConflictSnapshot(other)).toMatchObject({ phase: 'ready', list: { totalCount: 2 } });
        expect(listWorkspaceSyncConflicts).toHaveBeenCalledTimes(3);
        expect(conflictReadHomeOrigins).toEqual(['https://workspace-sync.test', 'https://other-workspace.test', 'https://workspace-sync.test']);
        unsubscribe();
    });

    it('preserves an unobserved conflict page as stale without fetching it', async () => {
        const scope = { serverId: workspace.serverId, relationshipId: 'relationship-1', controllerMachineId: 'machine-a' };
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
        // Teardown cancels this read through the real owner.
        void refreshWorkspaceSyncConflicts(scope).catch(() => undefined);
        expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({ phase: 'refreshing',
            list: { conflicts: [{ path: 'known.txt' }] } });
    });

    it('rejects an in-flight page invalidated by a runtime event and refreshes observers from the first page', async () => {
        let resolveStalePage!: (value: unknown) => void;
        const scope = { serverId: workspace.serverId, relationshipId: 'relationship-1', controllerMachineId: 'machine-a' } as const;
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
        const unsubscribe = subscribeWorkspaceSyncConflicts(scope, () => {
            const snapshot = getWorkspaceSyncConflictSnapshot(scope);
            if (snapshot.phase === 'ready') {
                observedReadyPaths.push(snapshot.list?.conflicts.map((conflict) => conflict.path) ?? []);
            }
        });

        const staleRefresh = refreshWorkspaceSyncConflicts(scope);
        await vi.waitFor(() => expect(resolveStalePage).toBeTypeOf('function'));
        invalidateWorkspaceSyncConflicts(scope);
        resolveStalePage({
            status: 'page', relationshipId: 'relationship-1', totalCount: 1, nextCursor: null,
            conflicts: [{ relationshipId: 'relationship-1', path: 'stale.txt', alpha: { kind: 'file' }, beta: { kind: 'file' } }],
        });
        // Invalidation cancels the superseded read; its late reply must not publish either.
        await expect(staleRefresh).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(getWorkspaceSyncConflictSnapshot(scope)).toMatchObject({
            phase: 'ready',
            list: { conflicts: [{ path: 'fresh.txt' }] },
        }));

        expect(observedReadyPaths).not.toContainEqual(['stale.txt']);
        expect(listWorkspaceSyncConflicts).toHaveBeenCalledTimes(3);
        expect(listWorkspaceSyncConflicts).toHaveBeenNthCalledWith(3, {
            relationshipId: scope.relationshipId, controllerMachineId: scope.controllerMachineId });
        unsubscribe();
    });
});
