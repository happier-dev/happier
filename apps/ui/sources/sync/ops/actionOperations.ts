import {
    ACTION_OPERATION_RPC_METHODS_V1,
    ActionOperationCancelV1ResponseSchema,
    ActionOperationGetV1ResponseSchema,
    ActionOperationListV1ResponseSchema,
    type ActionOperationCancelV1Response,
    type ActionOperationGetV1Response,
    type ActionOperationListV1Request,
    type ActionOperationListV1Response,
} from '@happier-dev/protocol';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';

export type ActionOperationRpc = <Response, Request>(params: Readonly<{
    machineId: string;
    method: string;
    payload: Request;
    serverId?: string | null;
    timeoutMs?: number;
    onIssued?: () => void;
}>) => Promise<Response>;

type ActionOperationTransportParams = Readonly<{
    machineId: string;
    serverId?: string | null;
    rpc?: ActionOperationRpc;
}>;

type ResponseSchema<T> = Readonly<{
    safeParse(value: unknown):
        | Readonly<{ success: true; data: T }>
        | Readonly<{ success: false }>;
}>;

function parseResponse<T>(schema: ResponseSchema<T>, value: unknown, method: string): T {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const failure = value as Readonly<Record<string, unknown>>;
        if (typeof failure.error === 'string') {
            throw createRpcCallError({
                error: failure.error,
                errorCode: typeof failure.errorCode === 'string' ? failure.errorCode : undefined,
            });
        }
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid ${method} response`);
    return parsed.data;
}

function resolveRpc(params: ActionOperationTransportParams): ActionOperationRpc {
    return params.rpc ?? machineRpcWithServerScope;
}

/** Connection/reconnection reconciliation only; live revisions arrive by encrypted push. */
export async function listActionOperations(
    params: ActionOperationTransportParams & Readonly<{ request?: ActionOperationListV1Request }>,
): Promise<ActionOperationListV1Response> {
    const raw = await resolveRpc(params)<unknown, ActionOperationListV1Request>({
        machineId: params.machineId,
        method: ACTION_OPERATION_RPC_METHODS_V1.list,
        payload: params.request ?? {},
        serverId: params.serverId,
    });
    return parseResponse(ActionOperationListV1ResponseSchema, raw, ACTION_OPERATION_RPC_METHODS_V1.list);
}

export async function getActionOperation(
    params: ActionOperationTransportParams & Readonly<{ operationId: string }>,
): Promise<ActionOperationGetV1Response> {
    const raw = await resolveRpc(params)<unknown, Readonly<{ operationId: string }>>({
        machineId: params.machineId,
        method: ACTION_OPERATION_RPC_METHODS_V1.get,
        payload: { operationId: params.operationId },
        serverId: params.serverId,
    });
    return parseResponse(ActionOperationGetV1ResponseSchema, raw, ACTION_OPERATION_RPC_METHODS_V1.get);
}

export async function cancelActionOperation(
    params: ActionOperationTransportParams & Readonly<{ operationId: string }>,
): Promise<ActionOperationCancelV1Response> {
    const raw = await resolveRpc(params)<unknown, Readonly<{ operationId: string }>>({
        machineId: params.machineId,
        method: ACTION_OPERATION_RPC_METHODS_V1.cancel,
        payload: { operationId: params.operationId },
        serverId: params.serverId,
    });
    return parseResponse(ActionOperationCancelV1ResponseSchema, raw, ACTION_OPERATION_RPC_METHODS_V1.cancel);
}
