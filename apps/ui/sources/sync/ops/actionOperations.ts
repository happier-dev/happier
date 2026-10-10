import {
    ACTION_OPERATION_RPC_METHODS_V2,
    ACTION_OPERATION_RPC_METHODS_V1,
    ActionOperationGetV1ResponseSchema,
    ActionOperationListV1ResponseSchema,
    type ActionOperationGetV1Response,
    type ActionOperationListV1Request,
    type ActionOperationListV1Response,
} from '@happier-dev/protocol/actions/operations/v1';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createRpcCallError } from '@/sync/runtime/rpcErrors';

export type ActionOperationRpc = <Response, Request>(params: Readonly<{
    machineId: string;
    method: string;
    payload: Request;
    serverId?: string | null;
    accountId?: string | null;
    timeoutMs?: number;
    onIssued?: () => void;
}>) => Promise<Response>;

type ActionOperationTransportParams = Readonly<{
    machineId: string;
    serverId?: string | null;
    accountId?: string | null;
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

async function readActionOperationObservation<Response, Request>(
    params: ActionOperationTransportParams,
    payload: Request,
    schema: ResponseSchema<Response>,
    methods: Readonly<{ current: string; predecessor: string }>,
    requireCurrentDomainFacts: boolean | (() => boolean) = false,
): Promise<Response> {
    const read = async (method: string) => parseResponse(schema, await resolveRpc(params)<unknown, Request>({
        machineId: params.machineId,
        method,
        payload,
        serverId: params.serverId,
        accountId: params.accountId,
    }), method);
    try {
        return await read(methods.current);
    } catch (error) {
        // ../0.2 at 37a6541578749067b49d4579be8c752c9591b8c8 registers V1 only.
        // Auth refusals, malformed data and current-domain inspection never downgrade.
        const requiresCurrent = () => typeof requireCurrentDomainFacts === 'function'
            ? requireCurrentDomainFacts() : requireCurrentDomainFacts;
        if (requiresCurrent() || !(isRpcMethodNotAvailableError(error) || isRpcMethodNotFoundError(error))) throw error;
        const response = await read(methods.predecessor);
        // A rich push can arrive while the old read is pending. Retained current
        // owner facts must not be replaced by that predecessor projection.
        if (requiresCurrent()) throw error;
        return response;
    }
}

/** Connection/reconnection reconciliation; live notifications inspect the same owner with get. */
export async function listActionOperations(
    params: ActionOperationTransportParams & Readonly<{
        request?: ActionOperationListV1Request;
        requireCurrentDomainFacts?: true | (() => boolean);
    }>,
): Promise<ActionOperationListV1Response> {
    return await readActionOperationObservation(params, params.request ?? {}, ActionOperationListV1ResponseSchema, {
        current: ACTION_OPERATION_RPC_METHODS_V2.list, predecessor: ACTION_OPERATION_RPC_METHODS_V1.list,
    }, params.requireCurrentDomainFacts);
}

export async function getActionOperation(
    params: ActionOperationTransportParams & Readonly<{
        operationId: string;
        /** Notification reconciliation needs current owner facts, not the released projection. */
        requireCurrentDomainFacts?: true;
    }>,
): Promise<ActionOperationGetV1Response> {
    // This reader has only the predecessor-compatible plain get payload, never richer wait flags.
    return await readActionOperationObservation(params, { operationId: params.operationId }, ActionOperationGetV1ResponseSchema, {
        current: ACTION_OPERATION_RPC_METHODS_V2.get, predecessor: ACTION_OPERATION_RPC_METHODS_V1.get,
    }, params.requireCurrentDomainFacts === true);
}
