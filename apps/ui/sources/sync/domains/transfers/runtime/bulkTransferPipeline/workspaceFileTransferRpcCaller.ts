import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';

import { resolvePreferScopedForBulkMachineTransfer } from './resolvePreferScopedForBulkMachineTransfer';

type TransferRpcFailure = Readonly<{ success: false; error: string; errorCode?: string }>;

type WorkspaceFileTransferRpcCallParams<TRequest> = Readonly<{
    request: TRequest;
    machineMethod: string;
    timeoutMs?: number | null;
}>;

export type WorkspaceFileTransferRpcCaller = Readonly<{
    call: <TResponse extends Readonly<{ success: boolean }>, TRequest>(
        params: WorkspaceFileTransferRpcCallParams<TRequest>,
    ) => Promise<TResponse>;
}>;

export function createWorkspaceFileTransferRpcCaller(params: Readonly<{
    machineId: string;
    serverId?: string | null;
    transferSizeBytes?: number | null;
}>): WorkspaceFileTransferRpcCaller {
    return {
        call: async <TResponse extends Readonly<{ success: boolean }>, TRequest>(
            callParams: WorkspaceFileTransferRpcCallParams<TRequest>,
        ): Promise<TResponse> => {
            try {
                const preferScoped = await resolvePreferScopedForBulkMachineTransfer({
                    machineId: params.machineId,
                    serverId: params.serverId,
                    timeoutMs: 500,
                });

                const response = await callGuardedMachineRpcWithPolicy<unknown, TRequest>({
                    machineId: params.machineId,
                    serverId: typeof params.serverId === 'string' ? params.serverId : undefined,
                    timeoutMs: typeof callParams.timeoutMs === 'number' ? callParams.timeoutMs : undefined,
                    preferScoped,
                    method: callParams.machineMethod,
                    payload: callParams.request,
                });

                return assertRpcResponseWithSuccess<TResponse>(response);
            } catch (error) {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Workspace transfer RPC failed',
                    errorCode: readRpcErrorCode(error),
                } as unknown as TResponse;
            }
        },
    };
}
