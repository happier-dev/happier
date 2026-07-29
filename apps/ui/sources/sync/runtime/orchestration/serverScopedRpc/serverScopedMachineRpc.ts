import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { isSocketIoAckTimeoutError } from '@/sync/runtime/socketIoAckTimeout';
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
import { resolveProductionMachineRpcRelayFallbackForServer } from '@/sync/domains/machines/peer/mediation/rpc/productionRelayFallback';
import { recordMachineRpcPeerMediationReceipt } from '@/sync/domains/machines/peer/mediation/rpc/receiptLog';

import type { ServerScopedMachineRpcParams, SocketRpcResult } from './serverScopedRpcTypes';
import { isGuardedMachineRpcMethod, resolveTransferPolicyAllowsMachineRpcDirect } from './guardedMachineRpcPolicy';
import { scopedSocketEmitWithAck } from './scopedSocketEmitWithAck';

const SCOPED_MACHINE_RPC_SESSION_WRITE_METHODS = new Set<string>([
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY,
    RPC_METHODS.SESSION_FORK,
    RPC_METHODS.SESSION_FORK_PROVIDER_SAFE,
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
    remainingTimeoutMs: number;
}>): Error {
    const error = new Error(
        `Machine RPC timed out after ${params.timeoutMs}ms while using ${params.scope} scope for ${params.method}`,
    );
    Object.assign(error, {
        code: 'MACHINE_RPC_TIMEOUT',
        timeoutMs: params.timeoutMs,
        remainingTimeoutMs: params.remainingTimeoutMs,
    });
    return error;
}

function isMachineRpcTimeoutError(error: unknown): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && (error as { code?: unknown }).code === 'MACHINE_RPC_TIMEOUT',
    );
}

function createMachineRpcAbortError(method: string): Error {
    const error = new Error(`Machine RPC for ${method} was aborted by the caller`);
    error.name = 'AbortError';
    Object.assign(error, { code: 'MACHINE_RPC_ABORTED' });
    return error;
}

/**
 * Race an in-flight RPC attempt against an optional caller abort signal so the
 * call rejects promptly when cancelled. Mirrors the explicit cancel-RPC pattern
 * used for timeouts; the underlying transport keeps its own timeout budget.
 */
async function withMachineRpcAbort<T>(
    method: string,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
): Promise<T> {
    if (!signal) {
        return await run();
    }
    if (signal.aborted) {
        throw createMachineRpcAbortError(method);
    }
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(createMachineRpcAbortError(method));
        signal.addEventListener('abort', onAbort, { once: true });
        run().then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
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
        totalTimeoutMs?: number;
    }>,
): Promise<T> {
    if (!(params.timeoutMs > 0)) {
        return await promise;
    }
    return await new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(createMachineRpcTimeoutError({
                scope: params.scope,
                method: params.method,
                timeoutMs: params.totalTimeoutMs ?? params.timeoutMs,
                remainingTimeoutMs: params.timeoutMs,
            }));
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
                    totalTimeoutMs: params.timeoutMs,
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
    const guarded = isGuardedMachineRpcMethod(params.method);
    const allowDirect = guarded && params.skipTransferPolicyEvaluation !== true
        ? await resolveTransferPolicyAllowsMachineRpcDirect({ serverId: params.serverId ?? undefined })
        : true;
    const policyPreferScoped = guarded && !allowDirect;
    const initialPreferScoped = params.preferScoped === true || policyPreferScoped;
    const requestedServerId = normalizeId(params.serverId);
    const activeServerId = normalizeId(getActiveServerSnapshot().serverId);
    let exactIssuanceAttempted = false;
    const onIssued = params.onIssued
        ? () => {
            exactIssuanceAttempted = true;
            params.onIssued?.();
        }
        : undefined;

    const runOnce = async (options?: { forceScoped?: boolean }): Promise<R> => {
        const timeoutBudget = createMachineRpcTimeoutBudget({
            method: params.method,
            timeoutMs: configuredTimeoutMs,
        });
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
            let abandonedBeforeEmission = false;
            const activeOnIssued = onIssued
                ? () => {
                    if (abandonedBeforeEmission) {
                        throw new Error('Exact active machine RPC was superseded before emission');
                    }
                    onIssued();
                }
                : undefined;
            try {
                const result = await timeoutBudget.runWithinTimeout(
                    'active',
                    async (timeoutMs) =>
                        await apiSocket.machineRPC<R, A>(
                        context.machineId,
                        params.method,
                        params.payload,
                        {
                            timeoutMs,
                            ...(params.authorization ? { authorization: params.authorization } : {}),
                            ...(activeOnIssued ? { onIssued: activeOnIssued } : {}),
                        },
                    ),
                );
                return result;
            } catch (error) {
                if (exactIssuanceAttempted) {
                    throw error;
                }
                if (!shouldFallbackToScopedMachineRpc(error)) {
                    throw error;
                }
                // Timeout cannot cancel encryption/preparation already in progress. Fence the
                // abandoned active promise at its immediate pre-emit callback before fallback.
                abandonedBeforeEmission = true;
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
                async (timeoutMs) => {
                    try {
                        return await scopedSocketEmitWithAck<SocketRpcResult>({
                            socket,
                            event: SOCKET_RPC_EVENTS.CALL,
                            timeoutMs,
                            payload: {
                                method: `${context.machineId}:${params.method}`,
                                params: encryptedPayload,
                                timeoutMs,
                                ...(params.authorization ? { authorization: params.authorization } : {}),
                            },
                            onIssued,
                        });
                    } catch (error) {
                        if (isSocketIoAckTimeoutError(error)) {
                            throw createMachineRpcTimeoutError({
                                scope: 'scoped',
                                method: params.method,
                                timeoutMs: configuredTimeoutMs,
                                remainingTimeoutMs: timeoutMs,
                            });
                        }
                        throw error;
                    }
                },
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
            return await withMachineRpcAbort(params.method, params.signal, () => runOnce());
        } catch (error) {
            lastError = error;
            if (exactIssuanceAttempted) {
                throw error;
            }
            const rpcErrorCode = readRpcErrorCode(error);
            if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE && attempt === 0) {
                await delay(Math.min(250, configuredTimeoutMs));
                continue;
            }
            throw error;
        }
    }
    throw lastError ?? new Error('Machine RPC failed');
}

export async function machineRpcWithServerScope<R, A>(params: ServerScopedMachineRpcParams<A>): Promise<R> {
    if (params.onIssued) {
        return await machineRpcWithServerTransport<R, A>(params);
    }
    return await machineRpcWithPeerMediationRoute<R, A>({
        serverId: params.serverId,
        machineId: params.machineId,
        method: params.method,
        payload: params.payload,
        timeoutMs: params.timeoutMs,
        authorization: params.authorization,
        signal: params.signal,
        resolveDirectRoute: async (input) => await resolveProductionMachineRpcDirectRoute({
            ...input,
            timeoutMs: params.timeoutMs,
        }),
        postDirect: async (directInput) => await withMachineRpcAbort(
            params.method,
            params.signal,
            () => postProductionMachineRpcDirect(directInput),
        ),
        recordReceipt: recordMachineRpcPeerMediationReceipt,
        resolveRelayFallback: async (input) => await resolveProductionMachineRpcRelayFallbackForServer({
            policy: input.policy,
            serverId: params.serverId,
            timeoutMs: params.timeoutMs,
        }),
        serverFallback: async (fallbackInput) => await machineRpcWithServerTransport<R, A>({
            machineId: fallbackInput.machineId,
            method: fallbackInput.method,
            payload: fallbackInput.payload,
            serverId: fallbackInput.serverId,
            timeoutMs: fallbackInput.timeoutMs,
            authorization: fallbackInput.authorization,
            preferScoped: params.preferScoped,
            skipTransferPolicyEvaluation: params.skipTransferPolicyEvaluation,
            signal: params.signal,
            onIssued: params.onIssued,
        }),
    });
}
