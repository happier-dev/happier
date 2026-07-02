import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { resolveServerScopedContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedContext';
import { resolveScopedMachineDataKey } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { delay } from '@/utils/timing/time';
import {
    MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS,
    measureMachineEncryptRawAttribution,
    type MachineEncryptRawAttributionEventName,
} from '@/sync/encryption/machineEncryption';
import { machineRpcWithPeerMediationRoute } from '@/sync/domains/machines/peer/mediation/rpc/client';
import {
    postProductionMachineRpcDirect,
    resolveProductionMachineRpcDirectRoute,
} from '@/sync/domains/machines/peer/mediation/rpc/productionRoute';
import { recordMachineRpcPeerMediationReceipt } from '@/sync/domains/machines/peer/mediation/rpc/receiptLog';

import type { ServerScopedMachineRpcParams, SocketRpcResult } from './serverScopedRpcTypes';
import { isGuardedMachineRpcMethod, resolveTransferPolicyAllowsMachineRpcDirect } from './guardedMachineRpcPolicy';

const SCOPED_MACHINE_RPC_SESSION_WRITE_METHODS = new Set<string>([
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
    RPC_METHODS.SESSION_FORK,
    SESSION_RPC_METHODS.SESSION_ROLLBACK,
]);

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function resolveScopedMachineRpcEncryptRawAttributionEvent(method: string): MachineEncryptRawAttributionEventName {
    return SCOPED_MACHINE_RPC_SESSION_WRITE_METHODS.has(method)
        ? MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS.scopedRpcSessionWrite
        : MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS.scopedRpcOther;
}

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

function resolveMachineRpcTimeoutMs(timeoutMs: number | undefined): number {
    return typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 30_000;
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

function createMachineRpcTimeoutBudget(params: Readonly<{
    method: string;
    timeoutMs: number;
}>) {
    const startedAt = Date.now();

    const resolveRemainingTimeoutMs = (): number => {
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        return Math.max(1, params.timeoutMs - elapsedMs);
    };

    return {
        resolveRemainingTimeoutMs,
        async runWithinTimeout<T>(
            scope: MachineRpcTimeoutScope,
            operation: (timeoutMs: number) => Promise<T>,
        ): Promise<T> {
            const timeoutMs = resolveRemainingTimeoutMs();
            return await withMachineRpcTimeout(
                operation(timeoutMs),
                {
                    scope,
                    method: params.method,
                    timeoutMs,
                },
            );
        },
    };
}

function shouldFallbackToScopedMachineRpc(error: unknown): boolean {
    const rpcErrorCode = readRpcErrorCode(error);
    if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE) return true;
    if (isMachineRpcTimeoutError(error)) return true;
    if (!(error instanceof Error)) return false;
    return error.message.includes('Machine encryption not found')
        || error.message.includes("reading 'getMachineEncryption'")
        || error.message.includes('Socket not connected');
}

async function machineRpcWithServerTransport<R, A>(params: ServerScopedMachineRpcParams<A>): Promise<R> {
    const configuredTimeoutMs = resolveMachineRpcTimeoutMs(params.timeoutMs);
    const timeoutBudget = createMachineRpcTimeoutBudget({
        method: params.method,
        timeoutMs: configuredTimeoutMs,
    });
    const guarded = isGuardedMachineRpcMethod(params.method);
    const allowDirect = guarded && params.skipTransferPolicyEvaluation !== true
        ? await resolveTransferPolicyAllowsMachineRpcDirect({ serverId: params.serverId ?? undefined })
        : true;
    const policyPreferScoped = guarded && !allowDirect;
    const initialPreferScoped = params.preferScoped === true || policyPreferScoped;
    const requestedServerId = normalizeId(params.serverId);
    const activeServerId = normalizeId(getActiveServerSnapshot().serverId);

    const runOnce = async (options?: { forceScoped?: boolean }): Promise<R> => {
        const preferScoped = options?.forceScoped === true || initialPreferScoped;
        const requestedScopedContext = preferScoped
            || Boolean(requestedServerId && !areServerProfileIdentifiersEquivalent(requestedServerId, activeServerId));
        const context = await timeoutBudget.runWithinTimeout(
            requestedScopedContext ? 'scoped' : 'active',
            async (timeoutMs) =>
                await resolveServerScopedContext({
                    machineId: params.machineId,
                    serverId: params.serverId,
                    forceScoped: preferScoped,
                    timeoutMs,
                }),
        );

        if (context.scope === 'active' && !preferScoped) {
            try {
                const result = await timeoutBudget.runWithinTimeout(
                    'active',
                    async (timeoutMs) =>
                        await apiSocket.machineRPC<R, A>(
                        context.machineId,
                        params.method,
                        params.payload,
                        { timeoutMs },
                    ),
                );
                return result;
            } catch (error) {
                if (!shouldFallbackToScopedMachineRpc(error)) {
                    throw error;
                }
                return await runOnce({ forceScoped: true });
            }
        }

        if (context.scope !== 'scoped') {
            throw new Error('Expected scoped server RPC context');
        }

        const machineDataKey = await timeoutBudget.runWithinTimeout(
            'scoped',
            async (timeoutMs) =>
                await resolveScopedMachineDataKey({
                    serverId: context.targetServerId,
                    serverUrl: context.targetServerUrl,
                    token: context.token,
                    machineId: context.machineId,
                    timeoutMs,
                    decryptEncryptionKey: (value) => context.encryption.decryptEncryptionKey(value),
                }),
        );

        await timeoutBudget.runWithinTimeout(
            'scoped',
            async () => {
                await context.encryption.initializeMachines(new Map([[context.machineId, machineDataKey]]));
                return undefined;
            },
        );
        const machineEncryption = context.encryption.getMachineEncryption(context.machineId);
        if (!machineEncryption) {
            throw new Error(`Machine encryption not found for ${context.machineId}`);
        }

        const socket = await timeoutBudget.runWithinTimeout(
            'scoped',
            async (timeoutMs) =>
                await createEphemeralServerSocketClient({
                    serverUrl: context.targetServerUrl,
                    token: context.token,
                    timeoutMs,
                }),
        );
        try {
            const encryptedPayload = await timeoutBudget.runWithinTimeout(
                'scoped',
                async () => await measureMachineEncryptRawAttribution(
                    resolveScopedMachineRpcEncryptRawAttributionEvent(params.method),
                    async () => await machineEncryption.encryptRaw(params.payload),
                ),
            );
            const result = await timeoutBudget.runWithinTimeout(
                'scoped',
                async (timeoutMs) =>
                    await socket
                        .timeout(timeoutMs)
                        .emitWithAck(SOCKET_RPC_EVENTS.CALL, {
                            method: `${context.machineId}:${params.method}`,
                            params: encryptedPayload,
                            timeoutMs,
                        }) as Promise<SocketRpcResult>,
            );

            if (result.ok) {
                const decoded = await timeoutBudget.runWithinTimeout(
                    'scoped',
                    async () => await machineEncryption.decryptRaw(result.result) as R,
                );
                return decoded;
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
                await timeoutBudget.runWithinTimeout(
                    'scoped',
                    async (timeoutMs) => {
                        await delay(Math.min(250, timeoutMs));
                        return undefined;
                    },
                );
                continue;
            }
            throw error;
        }
    }
    throw lastError ?? new Error('Machine RPC failed');
}

export async function machineRpcWithServerScope<R, A>(params: ServerScopedMachineRpcParams<A>): Promise<R> {
    return await machineRpcWithPeerMediationRoute<R, A>({
        serverId: params.serverId,
        machineId: params.machineId,
        method: params.method,
        payload: params.payload,
        timeoutMs: params.timeoutMs,
        resolveDirectRoute: async (input) => await resolveProductionMachineRpcDirectRoute({
            ...input,
            timeoutMs: params.timeoutMs,
        }),
        postDirect: postProductionMachineRpcDirect,
        recordReceipt: recordMachineRpcPeerMediationReceipt,
        serverFallback: async (fallbackInput) => await machineRpcWithServerTransport<R, A>({
            machineId: fallbackInput.machineId,
            method: fallbackInput.method,
            payload: fallbackInput.payload,
            serverId: fallbackInput.serverId,
            timeoutMs: fallbackInput.timeoutMs,
            preferScoped: params.preferScoped,
            skipTransferPolicyEvaluation: params.skipTransferPolicyEvaluation,
        }),
    });
}
