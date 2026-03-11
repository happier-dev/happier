import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { resolveServerScopedContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedContext';
import { resolveScopedMachineDataKey } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { delay } from '@/utils/timing/time';

import type { ServerScopedMachineRpcParams, SocketRpcResult } from './serverScopedRpcTypes';

type MachineRpcTimeoutScope = 'active' | 'scoped';

function createMachineRpcTimeoutError(params: Readonly<{
    scope: MachineRpcTimeoutScope;
    method: string;
    timeoutMs: number;
}>): Error {
    const error = new Error(
        `Machine RPC timed out after ${params.timeoutMs}ms while using ${params.scope} scope for ${params.method}`,
    );
    Object.assign(error, { code: 'MACHINE_RPC_TIMEOUT' });
    return error;
}

function isMachineRpcTimeoutError(error: unknown): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && (error as { code?: unknown }).code === 'MACHINE_RPC_TIMEOUT',
    );
}

async function withMachineRpcTimeout<T>(
    promise: Promise<T>,
    params: Readonly<{
        scope: MachineRpcTimeoutScope;
        method: string;
        timeoutMs: number;
    }>,
): Promise<T> {
    if (!(params.timeoutMs > 0)) {
        return await promise;
    }
    return await new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(createMachineRpcTimeoutError(params));
        }, params.timeoutMs);
        promise.then(
            (value) => {
                clearTimeout(timeoutId);
                resolve(value);
            },
            (error) => {
                clearTimeout(timeoutId);
                reject(error);
            },
        );
    });
}

function shouldFallbackToScopedMachineRpc(error: unknown): boolean {
    const rpcErrorCode = readRpcErrorCode(error);
    if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return true;
    if (isMachineRpcTimeoutError(error)) return true;
    if (!(error instanceof Error)) return false;
    return error.message.includes('Machine encryption not found')
        || error.message.includes('Socket not connected');
}

export async function machineRpcWithServerScope<R, A>(params: ServerScopedMachineRpcParams<A>): Promise<R> {
    const runOnce = async (options?: { forceScoped?: boolean }): Promise<R> => {
        const context = await resolveServerScopedContext({
            machineId: params.machineId,
            serverId: params.serverId,
            forceScoped: options?.forceScoped === true,
            timeoutMs: params.timeoutMs,
        });

        if (context.scope === 'active') {
            try {
                return await withMachineRpcTimeout(
                    apiSocket.machineRPC<R, A>(
                        context.machineId,
                        params.method,
                        params.payload,
                        { timeoutMs: context.timeoutMs },
                    ),
                    {
                        scope: 'active',
                        method: params.method,
                        timeoutMs: context.timeoutMs,
                    },
                );
            } catch (error) {
                if (!shouldFallbackToScopedMachineRpc(error)) {
                    throw error;
                }
                return await runOnce({ forceScoped: true });
            }
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
            const result = await withMachineRpcTimeout(
                socket
                    .timeout(context.timeoutMs)
                    .emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                        method: `${context.machineId}:${params.method}`,
                        params: await machineEncryption.encryptRaw(params.payload),
                        timeoutMs: context.timeoutMs,
                    }) as Promise<SocketRpcResult>,
                {
                    scope: 'scoped',
                    method: params.method,
                    timeoutMs: context.timeoutMs,
                },
            );

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
    };

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await runOnce();
        } catch (error) {
            lastError = error;
            const rpcErrorCode = readRpcErrorCode(error);
            if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE && attempt === 0) {
                await delay(250);
                continue;
            }
            throw error;
        }
    }
    throw lastError ?? new Error('Machine RPC failed');
}
