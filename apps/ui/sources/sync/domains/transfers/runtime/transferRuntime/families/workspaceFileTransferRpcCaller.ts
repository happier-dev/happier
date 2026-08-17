import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';

import { resolvePreferScopedMachineRpc } from '../routing/resolvePreferScopedMachineRpc';

type WorkspaceFileTransferRpcCallParams<TRequest> = Readonly<{
    request: TRequest;
    machineMethod: string;
    timeoutMs?: number | null;
    /** The caller owns cancellation; this guarded boundary must preserve it. */
    signal?: AbortSignal | null;
}>;

export type WorkspaceFileTransferRpcCaller = Readonly<{
    call: <TResponse extends Readonly<{ success: boolean }>, TRequest>(
        params: WorkspaceFileTransferRpcCallParams<TRequest>,
    ) => Promise<TResponse>;
}>;

function normalizeServerId(serverId?: string | null): string | undefined {
    return typeof serverId === 'string' ? serverId : undefined;
}

export function createWorkspaceFileTransferRpcCaller(params: Readonly<{
    machineId: string;
    serverId?: string | null;
}>): WorkspaceFileTransferRpcCaller {
    let preferScopedPromise: Promise<boolean> | null = null;

    const getPreferScoped = async (): Promise<boolean> => {
        preferScopedPromise ??= resolvePreferScopedMachineRpc({
            machineId: params.machineId,
            serverId: params.serverId,
            timeoutMs: 500,
        });
        return await preferScopedPromise;
    };

    return {
        call: async <TResponse extends Readonly<{ success: boolean }>, TRequest>(
            callParams: WorkspaceFileTransferRpcCallParams<TRequest>,
        ): Promise<TResponse> => {
            try {
                const response = await callGuardedMachineRpcWithPolicy<unknown, TRequest>({
                    machineId: params.machineId,
                    serverId: normalizeServerId(params.serverId),
                    timeoutMs: typeof callParams.timeoutMs === 'number' ? callParams.timeoutMs : undefined,
                    ...(callParams.signal ? { signal: callParams.signal } : {}),
                    preferScoped: await getPreferScoped(),
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
