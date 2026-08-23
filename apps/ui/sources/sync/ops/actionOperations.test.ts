import { describe, expect, it } from 'vitest';

import {
    ACTION_OPERATION_RPC_METHODS_V1,
    type ActionOperationSnapshotV1,
} from '@happier-dev/protocol';

import {
    cancelActionOperation,
    getActionOperation,
    listActionOperations,
    type ActionOperationRpc,
} from './actionOperations';

const accepted: ActionOperationSnapshotV1 = {
    version: 1,
    operationId: 'operation-1',
    revision: 1,
    actionId: 'session.spawn_new',
    state: 'accepted',
    scope: {
        accountId: 'account-1',
        machineId: 'machine-1',
        sessionId: 'session-1',
    },
    title: 'Create session',
    createdAt: 1_000,
    cancellation: 'unsupported',
};

function createRpc(
    implementation: (params: Parameters<ActionOperationRpc>[0]) => Promise<unknown>,
): ActionOperationRpc {
    return implementation as ActionOperationRpc;
}

describe('action operation transport', () => {
    it('maps and validates retained list/get/cancel methods without a start or wait ingress', async () => {
        const responses: Record<string, unknown> = {
            [ACTION_OPERATION_RPC_METHODS_V1.list]: { items: [accepted], nextCursor: null },
            [ACTION_OPERATION_RPC_METHODS_V1.get]: { kind: 'found', operation: accepted },
            [ACTION_OPERATION_RPC_METHODS_V1.cancel]: { kind: 'unsupported' },
        };
        const calls: Array<Readonly<{ method: string; payload: unknown }>> = [];
        const rpc = createRpc(async (params) => {
            calls.push({ method: params.method, payload: params.payload });
            return responses[params.method];
        });

        await expect(listActionOperations({ machineId: 'machine-1', rpc })).resolves.toEqual(responses[ACTION_OPERATION_RPC_METHODS_V1.list]);
        await expect(getActionOperation({ machineId: 'machine-1', operationId: 'operation-1', rpc })).resolves.toEqual(responses[ACTION_OPERATION_RPC_METHODS_V1.get]);
        await expect(cancelActionOperation({ machineId: 'machine-1', operationId: 'operation-1', rpc })).resolves.toEqual({ kind: 'unsupported' });

        expect(calls).toEqual([
            { method: ACTION_OPERATION_RPC_METHODS_V1.list, payload: {} },
            { method: ACTION_OPERATION_RPC_METHODS_V1.get, payload: { operationId: 'operation-1' } },
            { method: ACTION_OPERATION_RPC_METHODS_V1.cancel, payload: { operationId: 'operation-1' } },
        ]);
    });

    it('preserves structured daemon failures returned inside encrypted RPC results', async () => {
        const rpc = createRpc(async () => ({
            error: 'Operation lookup failed',
            errorCode: 'operation_lookup_failed',
        }));

        await expect(getActionOperation({
            machineId: 'machine-1',
            operationId: 'operation-1',
            rpc,
        })).rejects.toMatchObject({
            message: 'Operation lookup failed',
            rpcErrorCode: 'operation_lookup_failed',
        });
    });
});
