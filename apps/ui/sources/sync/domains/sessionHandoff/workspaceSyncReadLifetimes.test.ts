import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createWorkspaceSyncStatusWatchBoundary } from '@/dev/testkit/harness/workspaceSyncStatusWatchBoundary';
import { createWorkspaceSyncHarness, createWorkspaceSyncRelationshipsListFixture } from '@/dev/testkit/harness/workspaceSyncHarness';

const watches = createWorkspaceSyncStatusWatchBoundary();

const boundary = vi.hoisted(() => ({ pending: true, requests: [] as { signal?: AbortSignal }[] }));
// The daemon transport is the boundary; read stores, operation adapters and schemas stay real.
const workspace = createWorkspaceSyncHarness(async input => {
        if (input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_WATCH) return await watches.watch({ signal: input.signal });
        boundary.requests.push(input);
        if (boundary.pending) await new Promise<void>((_resolve, reject) => input.signal?.addEventListener('abort',
            () => reject(new Error('aborted')), { once: true }));
        return input.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIPS_LIST ? createWorkspaceSyncRelationshipsListFixture([]) : {
            status: 'page', relationshipId: (input.payload as { relationshipId: string }).relationshipId, totalCount: 0, nextCursor: null, conflicts: [],
        };
});
await workspace.ready;
const status = await import('./workspaceSyncStatusStore');
const conflict = await import('./workspaceSyncConflictStore');
beforeEach(async () => { await workspace.reset(); });
afterEach(async () => { status.resetWorkspaceSyncStatusStoreForTests(); conflict.resetWorkspaceSyncConflictStoreForTests();
    watches.reset();
    boundary.pending = true; boundary.requests.length = 0; await workspace.dispose(); });

it.each(['statuses', 'conflicts'] as const)('cancels the shared %s read only after its last consumer leaves and admits the next read', async kind => {
    const scope = { serverId: workspace.serverId, controllerMachineId: 'machine-a', relationshipId: 'relationship-one' };
    const other = kind === 'statuses' ? { ...scope, relationshipId: 'relationship-two' } : scope;
    const subscribe = kind === 'statuses' ? status.subscribeWorkspaceSyncStatus : conflict.subscribeWorkspaceSyncConflicts;
    const read = () => kind === 'statuses' ? status.refreshWorkspaceSyncStatuses([scope, other])
        : conflict.refreshWorkspaceSyncConflicts(scope);
    const first = subscribe(scope, () => {});
    const second = subscribe(other, () => {});
    const pending = read().catch(() => undefined);
    await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
    first();
    expect(boundary.requests[0]?.signal?.aborted).toBe(false);
    second();
    expect(boundary.requests[0]?.signal?.aborted).toBe(true);
    await pending;
    boundary.pending = false;
    const unsubscribe = subscribe(scope, () => {});
    await read();
    expect(boundary.requests).toHaveLength(2);
    const snapshot = kind === 'statuses' ? status.getWorkspaceSyncStatusSnapshot(scope)
        : conflict.getWorkspaceSyncConflictSnapshot(scope);
    expect(snapshot.phase).toBe('ready');
    unsubscribe();
});
