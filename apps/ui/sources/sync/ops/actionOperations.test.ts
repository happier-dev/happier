import { describe, expect, it, vi } from 'vitest';

import {
    ACTION_OPERATION_RPC_METHODS_V1,
    ACTION_OPERATION_RPC_METHODS_V2,
    type ActionOperationSnapshotV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import {
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
    it('retains current Project review facts through the rich observation reader, not the predecessor projection', async () => {
        const review: ActionOperationSnapshotV1 = { ...accepted, actionId: 'projects.script.run',
            domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home', machineId: 'machine-1',
                workspaceRefId: 'workspace', cwd: '/project' },
            setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required',
                reviewedEffectDigest: 'reviewed-effect', reviewedEffect: { commands: ['install'] } },
        };
        const { domainRef: _attachment, setupReview: _review, ...legacy } = review;
        const responses: Record<string, unknown> = {
            [ACTION_OPERATION_RPC_METHODS_V1.list]: { items: [legacy], nextCursor: null },
            [ACTION_OPERATION_RPC_METHODS_V1.get]: { kind: 'found', operation: legacy },
            [ACTION_OPERATION_RPC_METHODS_V2.list]: { items: [review], nextCursor: null },
            [ACTION_OPERATION_RPC_METHODS_V2.get]: { kind: 'found', operation: review },
        };
        const calls: Array<Readonly<{ method: string; payload: unknown }>> = [];
        const rpc = createRpc(async (params) => {
            calls.push({
                method: params.method,
                payload: params.payload,
            });
            return responses[params.method];
        });

        await expect(listActionOperations({ machineId: 'machine-1', rpc })).resolves.toEqual(responses[ACTION_OPERATION_RPC_METHODS_V2.list]);
        await expect(getActionOperation({ machineId: 'machine-1', operationId: 'operation-1', rpc })).resolves.toEqual(responses[ACTION_OPERATION_RPC_METHODS_V2.get]);

        expect(calls).toEqual([
            { method: ACTION_OPERATION_RPC_METHODS_V2.list, payload: {} },
            { method: ACTION_OPERATION_RPC_METHODS_V2.get, payload: { operationId: 'operation-1' } },
        ]);
    });

    it.each([
        ['list', listActionOperations, { machineId: 'machine-1' }],
        ['get', getActionOperation, { machineId: 'machine-1', operationId: 'operation-1' }],
    ] as const)('rejects malformed %s responses', async (_name, invoke, params) => {
        const rpc = createRpc(async ({ method }) => method === ACTION_OPERATION_RPC_METHODS_V1.get
            ? { kind: 'found', operation: accepted }
            : method === ACTION_OPERATION_RPC_METHODS_V1.list
                ? { items: [accepted], nextCursor: null } : { malformed: true });
        await expect(invoke({ ...params, rpc } as never)).rejects.toThrow('Invalid actionOperation.');
    });

    it.each([RPC_ERROR_CODES.METHOD_NOT_FOUND, RPC_ERROR_CODES.METHOD_NOT_AVAILABLE])(
        'reads the supported predecessor through V1 only when V2 is typed unavailable (%s)', async (errorCode) => {
            const rpc = createRpc(async (params) => {
                expect(params).toMatchObject({ serverId: 'home-1', machineId: 'machine-1' });
                if (params.method === ACTION_OPERATION_RPC_METHODS_V2.get
                    || params.method === ACTION_OPERATION_RPC_METHODS_V2.list) {
                    return { error: 'Method not available', errorCode };
                }
                expect(params).toMatchObject({ accountId: 'account-1' });
                if (params.method === ACTION_OPERATION_RPC_METHODS_V1.get) {
                    // ../0.2's strict get has no richer wait/review flags.
                    expect(params.payload).toStrictEqual({ operationId: 'operation-1' });
                    return { kind: 'found', operation: accepted };
                }
                expect(params.method).toBe(ACTION_OPERATION_RPC_METHODS_V1.list);
                expect(params.payload).toStrictEqual({});
                return { items: [accepted], nextCursor: null };
            });
            const scope = { machineId: 'machine-1', serverId: 'home-1', accountId: 'account-1', rpc };
            await expect(getActionOperation({ ...scope, operationId: 'operation-1' })).resolves.toStrictEqual({
                kind: 'found', operation: accepted,
            });
            await expect(listActionOperations(scope)).resolves.toStrictEqual({ items: [accepted], nextCursor: null });
        },
    );

    it('does not downgrade an operation read after authorization is denied', async () => {
        const rpc = createRpc(async ({ method }) => {
            if (method === ACTION_OPERATION_RPC_METHODS_V2.get || method === ACTION_OPERATION_RPC_METHODS_V2.list) {
                return { error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN };
            }
            return method === ACTION_OPERATION_RPC_METHODS_V1.get
                ? { kind: 'found', operation: accepted } : { items: [accepted], nextCursor: null };
        });
        await expect(getActionOperation({ machineId: 'machine-1', operationId: 'operation-1', rpc }))
            .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
        await expect(listActionOperations({ machineId: 'machine-1', rpc }))
            .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
    });

    it('does not reinterpret a required current-domain read as a successful predecessor projection', async () => {
        const rpc = createRpc(async ({ method }) => method === ACTION_OPERATION_RPC_METHODS_V2.get
            ? { error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }
            : { kind: 'found', operation: accepted });
        const params = { machineId: 'machine-1', operationId: 'operation-1', rpc,
            requireCurrentDomainFacts: true as const };
        await expect(getActionOperation(params)).rejects.toMatchObject({
            rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });
    });
});
