import { describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import { createActionOperationStore } from './actionOperationStore';
import {
    bindActionOperationRuntimeToAccountLifetime,
    reconcileActionOperationsOnce,
    type ActionOperationMachineRuntimeScope,
} from './actionOperationRuntime';

const scope: ActionOperationMachineRuntimeScope = {
    accountId: 'account-1',
    machineId: 'machine-1',
    serverId: 'server-1',
};

function operation(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'operation-1',
        revision: 1,
        actionId: 'session.spawn_new',
        state: 'accepted',
        scope: {
            accountId: scope.accountId,
            machineId: scope.machineId,
        },
        title: 'Create session',
        createdAt: 1_000,
        cancellation: 'unsupported',
        ...overrides,
    };
}

describe('action operation observation runtime', () => {
    it('hydrates list pages once and leaves later revisions to pushed observations', async () => {
        const store = createActionOperationStore();
        const accepted = operation();
        const otherAccount = operation({
            operationId: 'wrong-account',
            scope: { accountId: 'account-2', machineId: scope.machineId },
        });
        const otherMachine = operation({
            operationId: 'wrong-machine',
            scope: { accountId: scope.accountId, machineId: 'machine-2' },
        });
        const list = vi.fn()
            .mockResolvedValueOnce({ items: [accepted, otherAccount], nextCursor: 'page-2' })
            .mockResolvedValueOnce({ items: [otherMachine], nextCursor: null });

        await reconcileActionOperationsOnce({
            scope,
            store,
            list,
        });

        expect(list).toHaveBeenNthCalledWith(1, {
            machineId: scope.machineId,
            serverId: scope.serverId,
            request: {},
        });
        expect(list).toHaveBeenNthCalledWith(2, {
            machineId: scope.machineId,
            serverId: scope.serverId,
            request: { cursor: 'page-2' },
        });
        expect([...store.getSnapshot().operationsById.keys()]).toEqual([accepted.operationId]);
        expect(store.getSnapshot().operationsById.get(accepted.operationId)).toBe(accepted);
        expect(store.getSnapshot().machineObservationById.get(scope.machineId)).toBe('available');
    });

    it('retains cached active rows as unavailable when a complete post-restart list is empty', async () => {
        const store = createActionOperationStore();
        const cached = operation();
        store.mergeSnapshots([cached]);

        await reconcileActionOperationsOnce({
            scope,
            store,
            list: async () => ({ items: [], nextCursor: null }),
        });

        expect(store.getSnapshot().operationsById.get(cached.operationId)).toBe(cached);
        expect(store.getSnapshot().machineObservationById.get(scope.machineId)).toBe('unavailable');
    });

    it('retains cached rows when pagination fails before the daemon projection is complete', async () => {
        const store = createActionOperationStore();
        const cached = operation();
        store.mergeSnapshots([cached]);
        const list = vi.fn()
            .mockResolvedValueOnce({ items: [], nextCursor: 'page-2' })
            .mockRejectedValueOnce(new Error('connection lost'));

        await expect(reconcileActionOperationsOnce({
            scope,
            store,
            list,
        })).rejects.toThrow('connection lost');

        expect(store.getSnapshot().operationsById.get(cached.operationId)).toBe(cached);
    });

    it('retires the singleton projection with the active server/account lifetime', () => {
        const store = createActionOperationStore();
        store.mergeSnapshots([operation()]);
        const stopAll = vi.fn();
        const retirement = { current: null as (() => void) | null };
        const lifetime = {
            scope: { accountId: scope.accountId, serverId: scope.serverId! },
            isCurrent: () => true,
            onRetire(callback: () => void) {
                retirement.current = callback;
                return { dispose: vi.fn() };
            },
        };

        bindActionOperationRuntimeToAccountLifetime({ lifetime, coordinator: { stopAll }, store });
        retirement.current?.();

        expect(stopAll).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot().operationsById.size).toBe(0);
    });
});
