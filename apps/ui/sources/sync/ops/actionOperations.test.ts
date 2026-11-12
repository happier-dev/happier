import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects } from '@/dev/testkit';

import {
    ACTION_OPERATION_RPC_METHODS_V1,
    ACTION_OPERATION_RPC_METHODS_V2} from '@happier-dev/protocol/actions';
import {
    type ActionOperationSnapshotV1,
} from '@happier-dev/protocol/actions/operations/v1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ActionOperationGetV2RequestSchema } from '@happier-dev/protocol/actions/operations/v1';

// These transport contracts supply their RPC boundary below; importing the
// live connection graph would add unrelated runtime ownership to this slice.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: vi.fn(),
}));

import {
    getActionOperation,
    listActionOperations,
    type ActionOperationRpc,
} from './actionOperations';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { observeActionOperationByRequestId } from '@/sync/domains/actionOperations/observeActionOperationByRequestId';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

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
    afterEach(() => {
        actionOperationStore.reset();
        vi.mocked(machineRpcWithServerScope).mockReset();
    });

    it('reports the owner read refusal code while settling its request observer', async () => {
        vi.mocked(machineRpcWithServerScope)
            .mockResolvedValueOnce({ items: [{ ...accepted, actionId: 'deployments.targets.link', requestId: 'created-resource-request' }], nextCursor: null })
            .mockResolvedValueOnce({ error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN });
        const onUnavailable = vi.fn();
        const pending = observeActionOperationByRequestId({ serverId: 'home-1', accountId: 'account-1', machineId: 'machine-1',
            requestIdentity: { actionId: 'deployments.targets.link', requestId: 'created-resource-request' }, onUnavailable });
        await expect(pending).resolves.toBeNull();
        expect(onUnavailable).toHaveBeenCalledExactlyOnceWith(RPC_ERROR_CODES.FORBIDDEN);
    });

    it('does not publish a late owner refusal after request observation is cancelled', async () => {
        const response = createDeferred<unknown>();
        vi.mocked(machineRpcWithServerScope).mockReturnValue(response.promise);
        const controller = new AbortController();
        const onUnavailable = vi.fn();
        const pending = observeActionOperationByRequestId({ serverId: 'home-1', accountId: 'account-1', machineId: 'machine-1',
            requestIdentity: { actionId: 'deployments.targets.link', requestId: 'created-resource-request' },
            signal: controller.signal, onUnavailable });
        controller.abort();
        response.resolve({ error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN });
        await expect(pending).resolves.toBeNull();
        await flushHookEffects();
        expect(onUnavailable).not.toHaveBeenCalled();
    });

    it('retains request observation across transport loss until the owner publishes its complete result', async () => {
        vi.mocked(machineRpcWithServerScope).mockResolvedValue({ error: 'Transport unavailable', errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE });
        const onUnavailable = vi.fn();
        let settled = false;
        const pending = observeActionOperationByRequestId({ serverId: 'home-1', accountId: 'account-1', machineId: 'machine-1',
            requestIdentity: { actionId: 'deployments.targets.link', requestId: 'created-resource-request' }, onUnavailable });
        void pending.then(() => { settled = true; });
        await flushHookEffects();
        expect(settled).toBe(false);
        expect(onUnavailable).not.toHaveBeenCalled();
        const terminal: ActionOperationSnapshotV1 = { ...accepted, actionId: 'deployments.targets.link',
            requestId: 'created-resource-request', state: 'failed', settledAt: 2_000 };
        actionOperationStore.mergeSnapshots({ serverId: 'home-1', snapshots: [terminal], snapshotComplete: true });
        await expect(pending).resolves.toEqual(terminal);
        expect(onUnavailable).not.toHaveBeenCalled();
    });

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
        await expect(getActionOperation({ machineId: 'machine-1', operationId: 'operation-1', refreshSetupReview: true, rpc }))
            .resolves.toEqual(responses[ACTION_OPERATION_RPC_METHODS_V2.get]);
        expect(ActionOperationGetV2RequestSchema.parse(calls.at(-1)?.payload))
            .toEqual({ operationId: 'operation-1', refreshSetupReview: true });
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
        await expect(getActionOperation({ machineId: 'machine-1', operationId: 'operation-1', rpc, refreshSetupReview: true }))
            .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        await expect(getActionOperation({ machineId: 'machine-1', operationId: 'operation-1', rpc, waitForTerminal: true }))
            .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    });

    it('never downgrades a qualified request lookup into an unfiltered predecessor inventory', async () => {
        const methods: string[] = [];
        const rpc = createRpc(async ({ method }) => {
            methods.push(method);
            return method === ACTION_OPERATION_RPC_METHODS_V2.list
                ? { error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }
                : { items: [accepted], nextCursor: null };
        });
        await expect(listActionOperations({ machineId: 'machine-1', rpc,
            request: { requestIdentity: { actionId: 'session.spawn_new', requestId: 'click' } } }))
            .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        expect(methods).toEqual([ACTION_OPERATION_RPC_METHODS_V2.list]);
    });
});
