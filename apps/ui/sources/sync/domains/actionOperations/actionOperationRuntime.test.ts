import { describe, expect, it, vi } from 'vitest';

import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

import { createActionOperationStore } from './actionOperationStore';
import {
    selectActionOperationObservation,
    selectActionOperationObservationForOperation,
} from './actionOperationSelectors';
import {
    createActionOperationRuntimeCoordinator,
    reconcileActionOperationsOnce,
    type ActionOperationMachineRuntimeScope,
} from './actionOperationRuntime';

const scope: ActionOperationMachineRuntimeScope = {
    accountId: 'account-1',
    machineId: 'machine-1',
    serverId: 'server-1',
};

function snapshot(params: Readonly<{
    operationId: string;
    revision: number;
    state: 'accepted' | 'running' | 'succeeded';
}>): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: params.operationId,
        revision: params.revision,
        actionId: 'session.spawn_new',
        state: params.state,
        scope: {
            accountId: scope.accountId,
            machineId: scope.machineId,
        },
        title: 'Create session',
        createdAt: 1_000,
        startedAt: params.state === 'accepted' ? undefined : 1_100,
        settledAt: params.state === 'succeeded' ? 1_200 : undefined,
        cancellation: 'unsupported',
    };
}

describe('action operation observation runtime', () => {
    it('hydrates the bounded list once without starting a rotating wait', async () => {
        const store = createActionOperationStore();
        const accepted = snapshot({ operationId: 'operation-1', revision: 1, state: 'accepted' });
        const list = vi.fn(async () => ({ items: [accepted], nextCursor: null }));

        await reconcileActionOperationsOnce({
            scope,
            store,
            list,
        });

        expect(list).toHaveBeenCalledWith({
            machineId: scope.machineId,
            serverId: scope.serverId,
            request: {},
        });
        expect(list).toHaveBeenCalledTimes(1);
        expect(store.getState().operationsById.get(accepted.operationId)).toBe(accepted);
    });

    it('keeps the last snapshot and projects unavailable when a cached active operation is gone after reconnect', async () => {
        const store = createActionOperationStore();
        const accepted = snapshot({ operationId: 'operation-1', revision: 1, state: 'accepted' });
        store.merge(accepted);

        await reconcileActionOperationsOnce({
            scope,
            store,
            list: async () => ({ items: [], nextCursor: null }),
        });

        expect(store.getState().operationsById.get(accepted.operationId)).toBe(accepted);
        expect(selectActionOperationObservation(store.getState(), scope)).toBe('available');
        expect(selectActionOperationObservationForOperation(store.getState(), accepted)).toBe('status_unavailable');
    });

    it('reconciles the complete paginated daemon list and prunes terminal rows no longer retained', async () => {
        const store = createActionOperationStore();
        const staleTerminal = snapshot({ operationId: 'stale-terminal', revision: 3, state: 'succeeded' });
        const currentTerminal = snapshot({ operationId: 'current-terminal', revision: 4, state: 'succeeded' });
        store.merge(staleTerminal);
        store.merge(currentTerminal);

        await reconcileActionOperationsOnce({
            scope,
            store,
            list: async () => ({ items: [currentTerminal], nextCursor: null }),
        });

        expect(store.getState().operationsById.has('stale-terminal')).toBe(false);
        expect(store.getState().operationsById.get('current-terminal')).toBe(currentTerminal);
    });

    it('runs one reconciliation per newly connected account/machine scope', async () => {
        const starts: string[] = [];
        const store = createActionOperationStore();
        store.merge(snapshot({ operationId: 'operation-1', revision: 2, state: 'running' }));
        const coordinator = createActionOperationRuntimeCoordinator({
            store,
            reconcileOnce: async ({ scope: runtimeScope }) => {
                starts.push(`${runtimeScope.accountId}:${runtimeScope.machineId}:${runtimeScope.serverId}`);
            },
        });

        coordinator.reconcile([scope, scope]);
        coordinator.reconcile([scope]);
        await vi.waitFor(() => expect(starts).toEqual(['account-1:machine-1:server-1']));

        const moved = { ...scope, serverId: 'server-2' };
        coordinator.reconcile([moved]);
        await vi.waitFor(() => expect(starts).toEqual([
            'account-1:machine-1:server-1',
            'account-1:machine-1:server-2',
        ]));
        expect(selectActionOperationObservation(store.getState(), scope)).toBe('status_unavailable');
    });

    it('does not retry and projects unavailable when reconciliation is unsupported', async () => {
        const store = createActionOperationStore();
        const reconcileOnce = vi.fn(async () => {
            throw new RpcError('unsupported', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        });
        const coordinator = createActionOperationRuntimeCoordinator({ store, reconcileOnce });

        coordinator.reconcile([scope]);
        await vi.waitFor(() => {
            expect(selectActionOperationObservation(store.getState(), scope)).toBe('status_unavailable');
        });

        expect(reconcileOnce).toHaveBeenCalledTimes(1);
    });
});
