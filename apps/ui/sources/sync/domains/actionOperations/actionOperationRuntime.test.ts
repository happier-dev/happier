import { describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import { ACTION_OPERATION_RPC_METHODS_V2, projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { listActionOperations, type ActionOperationRpc } from '@/sync/ops/actionOperations';

import { createActionOperationStore } from './actionOperationStore';
import { createActionOperationSelectors } from './actionOperationSelectors';
import { actionOperationAddressKey, actionOperationMachineAddressKey } from './qualifiedActionOperation';
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
    it.each(['retained before reconnect', 'arrives during predecessor read'] as const)(
        'preserves current rich facts when they are %s and V2 is unavailable', async timing => {
            const store = createActionOperationStore();
            const rich = operation({ actionId: 'projects.script.run', domainRef: {
                kind: 'projectCommand', purpose: 'script', serverId: scope.serverId, machineId: scope.machineId,
                workspaceRefId: 'workspace', cwd: '/project',
            } });
            if (timing === 'retained before reconnect') store.mergeSnapshots({ serverId: scope.serverId, snapshots: [rich] });
            const rpc = (async ({ method }: Parameters<ActionOperationRpc>[0]) => {
                if (method === ACTION_OPERATION_RPC_METHODS_V2.list) return {
                    error: 'Method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                };
                // Network list completion races a real current push/store update.
                if (timing === 'arrives during predecessor read') store.mergeSnapshots({ serverId: scope.serverId, snapshots: [rich] });
                return { items: [projectActionOperationSnapshotForV1Reader({ ...rich, revision: 2 })], nextCursor: null };
            }) as ActionOperationRpc;
            await expect(reconcileActionOperationsOnce({ scope, store,
                list: params => listActionOperations({ ...params, rpc }),
            })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
            expect(store.getSnapshot().operationsByKey.get(actionOperationAddressKey({
                serverId: scope.serverId, operationId: rich.operationId,
            }))?.snapshot).toStrictEqual(rich);
        },
    );

    it('retains ordinary predecessor reconciliation while qualifying its Account', async () => {
        const store = createActionOperationStore();
        const accepted = operation();
        const rpc = (async request => {
            expect(request).toMatchObject({ accountId: scope.accountId, machineId: scope.machineId, serverId: scope.serverId });
            return request.method === ACTION_OPERATION_RPC_METHODS_V2.list
                ? { error: 'Method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }
                : { items: [accepted], nextCursor: null };
        }) as ActionOperationRpc;
        await reconcileActionOperationsOnce({ scope, store, list: params => listActionOperations({ ...params, rpc }) });
        expect([...store.getSnapshot().operationsByKey.values()]).toStrictEqual([{ serverId: scope.serverId, snapshot: accepted }]);
    });

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
            accountId: scope.accountId,
            requireCurrentDomainFacts: expect.any(Function),
            request: {},
        });
        expect(list).toHaveBeenNthCalledWith(2, {
            machineId: scope.machineId,
            serverId: scope.serverId,
            accountId: scope.accountId,
            requireCurrentDomainFacts: expect.any(Function),
            request: { cursor: 'page-2' },
        });
        expect([...store.getSnapshot().operationsByKey.keys()]).toEqual([
            actionOperationAddressKey({ serverId: scope.serverId, operationId: accepted.operationId }),
        ]);
        expect([...store.getSnapshot().operationsByKey.values()][0]).toEqual({ serverId: scope.serverId, snapshot: accepted });
        expect([...store.getSnapshot().machineObservationByKey.values()]).toEqual(['available']);
    });

    it('retains cached active rows as unavailable when a complete post-restart list is empty', async () => {
        const store = createActionOperationStore();
        const cached = operation();
        store.mergeSnapshots({ serverId: scope.serverId, snapshots: [cached] });

        await reconcileActionOperationsOnce({
            scope,
            store,
            list: async () => ({ items: [], nextCursor: null }),
        });

        expect(store.getSnapshot().operationsByKey.get(actionOperationAddressKey({ serverId: scope.serverId, operationId: cached.operationId }))?.snapshot).toBe(cached);
        expect(store.getSnapshot().machineObservationByKey.get(actionOperationMachineAddressKey({ serverId: scope.serverId, machineId: scope.machineId }))).toBe('available');
        expect(createActionOperationSelectors().selectById(store.getSnapshot(), {
            serverId: scope.serverId,
            operationId: cached.operationId,
        })?.observation).toBe('unavailable');
    });

    it('retains cached rows when pagination fails before the daemon projection is complete', async () => {
        const store = createActionOperationStore();
        const cached = operation();
        store.mergeSnapshots({ serverId: scope.serverId, snapshots: [cached] });
        const list = vi.fn()
            .mockResolvedValueOnce({ items: [], nextCursor: 'page-2' })
            .mockRejectedValueOnce(new Error('connection lost'));

        await expect(reconcileActionOperationsOnce({
            scope,
            store,
            list,
        })).rejects.toThrow('connection lost');

        expect(store.getSnapshot().operationsByKey.get(actionOperationAddressKey({ serverId: scope.serverId, operationId: cached.operationId }))?.snapshot).toBe(cached);
    });

    it('retires the singleton projection with the active server/account lifetime', () => {
        const store = createActionOperationStore();
        store.mergeSnapshots({ serverId: scope.serverId, snapshots: [operation()] });
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
        expect(store.getSnapshot().operationsByKey.size).toBe(0);
    });
});
