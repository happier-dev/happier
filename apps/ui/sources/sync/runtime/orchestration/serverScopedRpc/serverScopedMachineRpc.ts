import {
    callSocketRpc,
    isSocketIoAckTimeoutError,
    markRpcRequestDisposition,
    readRpcRequestDisposition,
} from '@happier-dev/sync-client';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { createRpcCallError } from '@/sync/runtime/rpcErrors';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { createScopedSocketConnectParams } from '@/sync/runtime/orchestration/serverScopedRpc/createScopedSocketConnectParams';
import { resolveServerScopedContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedContext';
import { resolveScopedMachineTransport } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import { createServerRequestForExplicitServerScope } from './createServerRequestWithServerScope';
import { delay } from '@/utils/timing/time';
import {
    MACHINE_ENCRYPT_RAW_ATTRIBUTION_EVENTS,
    measureMachineEncryptRawAttribution,
    type MachineEncryptRawAttributionEventName,
} from '@/sync/encryption/machineEncryption';
import { machineRpcWithPeerMediationRoute, createPrivateContinuationTransportError } from '@/sync/domains/machines/peer/mediation/rpc/client';
import {
    postProductionMachineRpcDirect,
    resolveProductionMachineRpcDirectRoute,
} from '@/sync/domains/machines/peer/mediation/rpc/productionRoute';
import { resolveProductionMachineRpcRelayFallbackForServer } from '@/sync/domains/machines/peer/mediation/rpc/productionRelayFallback';
import { recordMachineRpcPeerMediationReceipt } from '@/sync/domains/machines/peer/mediation/rpc/receiptLog';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from './serverScopedRpcTypes';
import type { ServerScopedMachineRpcParams } from './serverScopedRpcTypes';
import { isGuardedMachineRpcMethod, resolveTransferPolicyAllowsMachineRpcDirect } from './guardedMachineRpcPolicy';
import {
    isMachineRpcTimeoutError,
    MACHINE_RPC_TIMEOUT_ERROR_CODE,
} from './machineRpcTimeoutError';
import { resolveMachineRpcTargetServerId } from './resolveMachineRpcTargetServerId';
import { resolveRunnerMachineContentKeyTrustV1 } from '@/sync/domains/machines/runnerMachineContentKeyTrust';
import { readMachineInstallationPublicKey } from '@/sync/domains/machines/machineInstallationPublicKey';

const SCOPED_MACHINE_RPC_SESSION_WRITE_METHODS = new Set<string>([
    RPC_METHODS.SPAWN_HAPPY_SESSION,
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    RPC_METHODS.SESSION_SPAWN_NEW,
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
        code: MACHINE_RPC_TIMEOUT_ERROR_CODE,
        timeoutMs: params.timeoutMs,
        remainingTimeoutMs: params.remainingTimeoutMs,
    });
    return error;
}

function createMachineRpcAbortError(method: string, cause?: unknown): Error {
    const error = new Error(`Machine RPC for ${method} was aborted by the caller`);
    error.name = 'AbortError';
    Object.assign(error, { code: 'MACHINE_RPC_ABORTED' });
    const disposition = readRpcRequestDisposition(cause);
    if (disposition) markRpcRequestDisposition(error, disposition);
    return error;
}

function throwIfMachineRpcAborted(method: string, signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    throw markRpcRequestDisposition(createMachineRpcAbortError(method), 'notSent');
}

/**
 * Fence setup and direct-peer work at the caller boundary. Socket RPC carries
 * this same signal into its request-correlated cancellation path; direct HTTP
 * remains owned by its existing transport implementation.
 */
async function withMachineRpcAbort<T>(
    method: string,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
    socketRpcAbortScope?: Readonly<{ issued: boolean }>,
): Promise<T> {
    if (!signal) {
        return await run();
    }
    if (signal.aborted) {
        throw markRpcRequestDisposition(createMachineRpcAbortError(method), 'notSent');
    }
    return await new Promise<T>((resolve, reject) => {
        // Once issued, the shared RPC owner cancels and classifies the outcome.
        // The caller fence remains responsible for setup and direct HTTP work.
        const onAbort = () => {
            if (!socketRpcAbortScope?.issued) reject(createMachineRpcAbortError(method));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        run().then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                // Issued Socket RPCs already settle cancellation at the shared,
                // request-correlated owner. A consumed ACK must not become an
                // unknown outcome merely because its caller retires afterward.
                if (signal.aborted && !socketRpcAbortScope?.issued) reject(createMachineRpcAbortError(method));
                else resolve(value);
            },
            (error) => {
                signal.removeEventListener('abort', onAbort);
                reject(signal.aborted ? createMachineRpcAbortError(method, error) : error);
            },
        );
    });
}

function resolveMachineRpcTimeoutMs(timeoutMs: number | undefined): number {
    return typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS;
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

async function machineRpcWithServerTransport<R, A>(
    params: ServerScopedMachineRpcParams<A>,
    socketRpcAbortScope: { issued: boolean },
): Promise<R> {
    const configuredTimeoutMs = resolveMachineRpcTimeoutMs(params.timeoutMs);
    const guarded = isGuardedMachineRpcMethod(params.method);
    const allowDirect = guarded && params.skipTransferPolicyEvaluation !== true
        ? await resolveTransferPolicyAllowsMachineRpcDirect({ serverId: params.serverId ?? undefined })
        : true;
    const policyPreferScoped = guarded && !allowDirect;
    const initialPreferScoped = params.preferScoped === true || params.requireEncryptedPayload === true || policyPreferScoped;
    const requestedServerId = normalizeId(params.serverId);
    const requestedAccountId = normalizeId(params.accountId);
    const activeServerId = normalizeId(getActiveServerSnapshot().serverId);
    let exactIssuanceAttempted = false;
    const onIssued = params.onIssued
        ? () => {
            exactIssuanceAttempted = true;
            params.onIssued?.();
        }
        : undefined;

    const runOnce = async (options?: { forceScoped?: boolean }): Promise<R> => {
        socketRpcAbortScope.issued = false;
        throwIfMachineRpcAborted(params.method, params.signal);
        const timeoutBudget = createMachineRpcTimeoutBudget({
            method: params.method,
            timeoutMs: configuredTimeoutMs,
        });
        const runOperation = async <T>(scope: MachineRpcTimeoutScope, operation: (timeoutMs: number | null) => Promise<T>): Promise<T> =>
            params.operationTimeoutMs === null
                ? await operation(null)
                : await timeoutBudget.runWithinTimeout(scope, operation);
        const preferScoped = options?.forceScoped === true || initialPreferScoped || Boolean(requestedAccountId);
        const requestedScopedContext = preferScoped
            || Boolean(requestedServerId && !areServerProfileIdentifiersEquivalent(requestedServerId, activeServerId));
        const context = await timeoutBudget.runWithinTimeout(
            requestedScopedContext ? 'scoped' : 'active',
            async (timeoutMs) =>
                await resolveServerScopedContext({
                    machineId: params.machineId,
                    serverId: params.serverId,
                    ...(requestedAccountId ? { accountId: requestedAccountId } : {}),
                    forceScoped: preferScoped,
                    timeoutMs,
                }),
        );
        if (params.signal?.aborted && context.scope === 'scoped') {
            await context.release?.();
        }
        throwIfMachineRpcAborted(params.method, params.signal);

        if (context.scope === 'active' && !preferScoped) {
            let abandonedBeforeEmission = false;
            const activeOnIssued = () => {
                if (abandonedBeforeEmission) {
                    throw new Error('Active machine RPC was superseded before emission');
                }
                onIssued?.();
                socketRpcAbortScope.issued = true;
                params.onDispatched?.();
            };
            try {
                const result = await runOperation(
                    'active',
                    async (timeoutMs) =>
                        await apiSocket.machineRPC<R, A>(
                        context.machineId,
                        params.method,
                        params.payload,
                        {
                            timeoutMs,
                            ...(params.requestId ? { requestId: params.requestId } : {}),
                            ...(params.authorization ? { authorization: params.authorization } : {}),
                            onIssued: activeOnIssued,
                            ...(params.signal ? { signal: params.signal } : {}),
                        },
                    ),
                );
                return result;
            } catch (error) {
                if (exactIssuanceAttempted || (params.method === RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE && socketRpcAbortScope.issued)) {
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

        let carrierCustodyTransferred = false;
        try {
            const credentials = context.credentials;
            const runnerTrust = credentials
                ? await timeoutBudget.runWithinTimeout('scoped', async () => await resolveRunnerMachineContentKeyTrustV1({
                    credentials,
                    homeServerIdentityId: context.targetServerId,
                    machineId: context.machineId,
                }))
                : null;
            const machineTransport = await timeoutBudget.runWithinTimeout(
                'scoped',
                async (timeoutMs) =>
                    await resolveScopedMachineTransport({
                    serverId: context.targetServerId,
                    serverUrl: context.targetServerUrl,
                    ...(context.runtimeOrigin ? { runtimeOrigin: context.runtimeOrigin } : {}),
                    ...(context.homeCarrier ? { homeCarrier: context.homeCarrier } : {}),
                    token: context.token,
                    machineId: context.machineId,
                    accountId: context.targetAccountId,
                    readAccountMode: async () => (await fetchAccountEncryptionMode(credentials ?? { token: context.token }, {
                        request: createServerRequestForExplicitServerScope({
                            serverUrl: context.targetServerUrl, token: context.token,
                            runtimeOrigin: context.runtimeOrigin, homeCarrier: context.homeCarrier, timeoutMs,
                        }),
                    })).mode,
                    ...(runnerTrust ? { expectedRunnerBinding: runnerTrust.expectedRunnerBinding } : {}),
                    ...(runnerTrust?.trustedMachineKind
                        ? { trustedMachineKind: runnerTrust.trustedMachineKind }
                        : {}),
                    timeoutMs,
                    ...(context.encryption
                        ? {
                            decryptEncryptionKey: (value: string) =>
                                context.encryption!.decryptEncryptionKey(value),
                            encryption: context.encryption,
                        }
                        : {}),
                    }),
            );
        throwIfMachineRpcAborted(params.method, params.signal);

        if (!machineTransport || (machineTransport.mode === 'e2ee' && !runnerTrust)) {
            await context.encryption?.initializeMachines(new Map(), new Set([context.machineId]));
            throw createRpcCallError({
                error: `Machine encryption not found for ${context.machineId}`,
                errorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE',
            });
        }
        const usePlaintextTransport = machineTransport.mode === 'plain';
        let requestPayload: unknown = params.payload;
        if (params.requireEncryptedPayload && usePlaintextTransport) {
            const { SessionRequesterBootstrapRpcRequestV1Schema, sealSessionRequesterBootstrapRpcRequestV1 } =
                await import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1');
            const request = SessionRequesterBootstrapRpcRequestV1Schema.safeParse(params.payload);
            const installationId = machineTransport.installationId;
            const publicKey = readMachineInstallationPublicKey(machineTransport.installationPublicKey);
            if (params.method !== RPC_METHODS.SESSION_SPAWN_NEW || !request.success || !installationId || !publicKey
                || request.data.input.executionTarget.machineId !== context.machineId
                || request.data.input.executionTarget.serverId !== context.targetServerId) {
                throw createRpcCallError({ error: 'Private Machine payload requires an encrypted transport', errorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' });
            }
            if ('kind' in request.data.requesterBootstrap) {
                if (request.data.requesterBootstrap.installationId !== installationId) {
                    throw createRpcCallError({ error: 'Private Machine payload has a stale installation', errorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' });
                }
                requestPayload = request.data;
            } else {
                requestPayload = sealSessionRequesterBootstrapRpcRequestV1({ request: {
                    kind: request.data.kind, input: request.data.input, requesterBootstrap: request.data.requesterBootstrap,
                }, installationId, installationPublicKey: publicKey, randomBytes: getRandomBytes });
            }
        }
        const isMachineCurrent = () => machineTransport.context?.isCurrent() !== false;
        if (usePlaintextTransport) context.encryption?.removeMachineEncryption(context.machineId);
        let machineEncryption = null;
        if (!usePlaintextTransport) {
            if (!context.encryption) {
                throw new Error(`Machine encryption not found for ${context.machineId}`);
            }
            await timeoutBudget.runWithinTimeout(
                'scoped',
                async () => {
                    await context.encryption!.initializeMachines(new Map([[
                        context.machineId,
                        machineTransport.mode === 'e2ee'
                            ? machineTransport.dataKey
                            : null,
                    ]]), undefined, { isMachineCurrent });
                    return undefined;
                },
            );
            machineEncryption = context.encryption.getMachineEncryption(context.machineId);
            if (!machineEncryption || !isMachineCurrent()) {
                throw new Error(`Machine encryption not found for ${context.machineId}`);
            }
        }
        throwIfMachineRpcAborted(params.method, params.signal);

        const socket = await timeoutBudget.runWithinTimeout(
            'scoped',
            async (timeoutMs) =>
                await createEphemeralServerSocketClient(
                    createScopedSocketConnectParams({
                        ...context,
                        timeoutMs,
                    }, () => {
                        carrierCustodyTransferred = true;
                        return context.release;
                    }),
                ),
        );
        try {
            throwIfMachineRpcAborted(params.method, params.signal);
            return await runOperation(
                'scoped',
                async (timeoutMs) => {
                    try {
                        return await callSocketRpc<R>({
                            randomBytes: getRandomBytes,
                            socket,
                            target: { kind: 'machine', id: context.machineId },
                            method: params.method,
                            params: requestPayload,
                            content: usePlaintextTransport
                                ? { mode: 'plain' }
                                : {
                                    mode: 'e2ee',
                                    cipher: {
                                        encryptRaw: async (payload) => await timeoutBudget.runWithinTimeout(
                                            'scoped',
                                            async () => await measureMachineEncryptRawAttribution(
                                                resolveScopedMachineRpcEncryptRawAttributionEvent(params.method),
                                                async () => await machineEncryption!.encryptRaw(payload),
                                            ),
                                        ),
                                        decryptRaw: async (payload) => await runOperation(
                                            'scoped',
                                            async () => await machineEncryption!.decryptRaw(payload),
                                        ),
                                    },
                                },
                            timeoutMs,
                            authorization: params.authorization,
                            requestId: params.requestId,
                            onIssued: () => {
                                if (!isMachineCurrent() || (!usePlaintextTransport && context.encryption?.getMachineEncryption(context.machineId) !== machineEncryption)) {
                                    throw createRpcCallError({ error: 'Machine encryption context changed before dispatch', errorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' });
                                }
                                onIssued?.();
                                socketRpcAbortScope.issued = true;
                                params.onDispatched?.();
                            },
                            signal: params.signal,
                        });
                    } catch (error) {
                        if (isSocketIoAckTimeoutError(error) && timeoutMs !== null) {
                            const timeoutError = createMachineRpcTimeoutError({
                                scope: 'scoped',
                                method: params.method,
                                timeoutMs: configuredTimeoutMs,
                                remainingTimeoutMs: timeoutMs,
                            });
                            const disposition = readRpcRequestDisposition(error);
                            throw disposition ? markRpcRequestDisposition(timeoutError, disposition) : timeoutError;
                        }
                        throw error;
                    }
                },
            );
        } finally {
            socket.disconnect();
        }
        } finally {
            if (!carrierCustodyTransferred) await context.release?.();
        }
    };

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await withMachineRpcAbort(params.method, params.signal, () => runOnce(), socketRpcAbortScope);
        } catch (error) {
            lastError = error;
            if (params.method === RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE && socketRpcAbortScope.issued) {
                throw createPrivateContinuationTransportError(error, true);
            }
            if (params.signal?.aborted) {
                throw createMachineRpcAbortError(params.method, error);
            }
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
    // Peer mediation, relay policy, and the server fallback must all use the
    // Home that owns this execution. During a Home handoff, `serverRuntime`
    // may already describe the next staged Home while the applied runtime
    // still serves the incumbent.
    const effectiveServerId = resolveMachineRpcTargetServerId(params.serverId);
    const effectiveParams: ServerScopedMachineRpcParams<A> = {
        ...params,
        serverId: effectiveServerId || undefined,
    };
    const socketRpcAbortScope = { issued: false };

    if (effectiveParams.onIssued || effectiveParams.requireEncryptedPayload) {
        return await machineRpcWithServerTransport<R, A>(effectiveParams, socketRpcAbortScope);
    }
    return await withMachineRpcAbort(
        effectiveParams.method,
        effectiveParams.signal,
        async () => await machineRpcWithPeerMediationRoute<R, A>({
            serverId: effectiveParams.serverId,
            accountId: effectiveParams.accountId,
            machineId: effectiveParams.machineId,
            method: effectiveParams.method,
            payload: effectiveParams.payload,
            timeoutMs: effectiveParams.timeoutMs,
            operationTimeoutMs: effectiveParams.operationTimeoutMs,
            authorization: effectiveParams.authorization,
            signal: effectiveParams.signal,
            onDispatched: effectiveParams.onDispatched,
            resolveDirectRoute: async (input) => await resolveProductionMachineRpcDirectRoute({
                ...input,
                serverId: effectiveParams.serverId,
                timeoutMs: effectiveParams.timeoutMs,
            }),
            postDirect: async (directInput) => await withMachineRpcAbort(
                effectiveParams.method,
                effectiveParams.signal,
                () => postProductionMachineRpcDirect(directInput),
            ),
            recordReceipt: recordMachineRpcPeerMediationReceipt,
            resolveRelayFallback: async (input) => await resolveProductionMachineRpcRelayFallbackForServer({
                policy: input.policy,
                serverId: effectiveParams.serverId,
                timeoutMs: effectiveParams.timeoutMs,
            }),
            serverFallback: async (fallbackInput) => await machineRpcWithServerTransport<R, A>({
                ...effectiveParams,
                machineId: fallbackInput.machineId,
                method: fallbackInput.method,
                payload: fallbackInput.payload,
                accountId: fallbackInput.accountId,
                timeoutMs: fallbackInput.timeoutMs,
                authorization: fallbackInput.authorization,
            }, socketRpcAbortScope),
        }),
        socketRpcAbortScope,
    );
}

/** Order asynchronous preparation through actual dispatch, never through RPC replies. */
export function createOrderedMachineRpcCaller(
    call: typeof machineRpcWithServerScope = machineRpcWithServerScope,
): typeof machineRpcWithServerScope {
    let dispatchTail = Promise.resolve();
    return async <R, A>(params: ServerScopedMachineRpcParams<A>): Promise<R> => {
        const previous = dispatchTail;
        let releaseDispatch!: () => void;
        const dispatched = new Promise<void>((resolve) => { releaseDispatch = resolve; });
        // A cancelled waiter must not let its successor overtake the previous dispatch.
        dispatchTail = previous.then(() => dispatched);
        try {
            return await withMachineRpcAbort(params.method, params.signal, async () => {
                await previous;
                throwIfMachineRpcAborted(params.method, params.signal);
                return await call<R, A>({
                    ...params,
                    onDispatched: () => {
                        releaseDispatch();
                        params.onDispatched?.();
                    },
                });
            });
        } finally {
            // Setup failure or cancellation must release the admission fence as well.
            releaseDispatch();
        }
    };
}
