import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { resolveServerScopedContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedContext';
import { resolveScopedMachineDataKey } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';

import type { ServerScopedMachineRpcParams, SocketRpcResult } from './serverScopedRpcTypes';

export async function machineRpcWithServerScope<R, A>(params: ServerScopedMachineRpcParams<A>): Promise<R> {
    const context = await resolveServerScopedContext({
        machineId: params.machineId,
        serverId: params.serverId,
        timeoutMs: params.timeoutMs,
    });

    if (context.scope === 'active') {
        return await apiSocket.machineRPC<R, A>(
            context.machineId,
            params.method,
            params.payload,
            { timeoutMs: context.timeoutMs },
        );
    }

    const machineDataKey = await resolveScopedMachineDataKey({
        serverId: context.targetServerId,
        serverUrl: context.targetServerUrl,
        token: context.token,
        machineId: context.machineId,
        timeoutMs: context.timeoutMs,
        decryptEncryptionKey: (value) => context.encryption.decryptEncryptionKey(value),
    });

    await context.encryption.initializeMachines(new Map([[context.machineId, machineDataKey]]));
    const machineEncryption = context.encryption.getMachineEncryption(context.machineId);
    if (!machineEncryption) {
        throw new Error(`Machine encryption not found for ${context.machineId}`);
    }

    const socket = await createEphemeralServerSocketClient({
        serverUrl: context.targetServerUrl,
        token: context.token,
        timeoutMs: context.timeoutMs,
    });
    try {
        const result = await socket
            .timeout(context.timeoutMs)
            .emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                method: `${context.machineId}:${params.method}`,
                params: await machineEncryption.encryptRaw(params.payload),
            }) as SocketRpcResult;

        if (result.ok) {
            return await machineEncryption.decryptRaw(result.result) as R;
        }

        throw createRpcCallError({
            error: typeof result.error === 'string' ? result.error : 'RPC call failed',
            errorCode: typeof result.errorCode === 'string' ? result.errorCode : undefined,
        });
    } finally {
        socket.disconnect();
    }
}
