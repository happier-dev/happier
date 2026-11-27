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
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { createScopedSocketConnectParams } from '@/sync/runtime/orchestration/serverScopedRpc/createScopedSocketConnectParams';
import { resolveServerScopedContext } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerScopedContext';
import { requireMachineTransportRow, resolveScopedMachineTransport } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import type { MachinePublishedRowV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import { assertMachineNotReportedOfflineV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { ScopedRpcSocketConnectionTimeoutError } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
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
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS, resolveMachineRpcTimeoutMs } from './serverScopedRpcTypes';
import type { ScopedSocketClient, ServerScopedMachineRpcParams } from './serverScopedRpcTypes';
import { isGuardedMachineRpcMethod, resolveTransferPolicyAllowsMachineRpcDirect } from './guardedMachineRpcPolicy';
import {
    isMachineRpcTimeoutError,
    MACHINE_RPC_TIMEOUT_ERROR_CODE,
} from './machineRpcTimeoutError';
import { resolveMachineRpcTargetServerId } from './resolveMachineRpcTargetServerId';
import { resolveRunnerMachineContentKeyTrustV1 } from '@/sync/domains/machines/runnerMachineContentKeyTrust';
import { readMachineInstallationPublicKey } from '@/sync/domains/machines/machineInstallationPublicKey';
import {
    isMachineRequestReachabilityFailure,
    recordMachineRequestFailed,
    recordMachineRequestSucceeded,
    captureMachinePresenceObservation,
    type MachineReachabilityScope,
} from '@/sync/domains/machines/reachability/machineReachability';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { parseToken } from '@/utils/auth/parseToken';
import { readAccountE2eeCustody } from '@/auth/storage/tokenStorage';
import { userRequestLeaseOwner } from '@/sync/runtime/connectivity/userRequestLease';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { runAdmittedMachineRpcRead } from './machineRpcReadAdmission';
import { prepareMachineRows, type PreparedMachineRows } from '@/sync/api/machines/machineRowsApi';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

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

type ScopedMachineTransportSelection = Readonly<{
    mode: 'plain' | 'e2ee';
    installationId?: string | null;
    installationPublicKey?: string | null;
}>;

/** Private Account key material never travels plain: seal it to the selected installation or refuse. */
async function prepareScopedMachineRequestPayload<A>(
    params: Pick<ServerScopedMachineRpcParams<A>, 'method' | 'payload' | 'requireEncryptedPayload'>,
    target: Readonly<{ machineId: string; targetServerId: string }>,
    transport: ScopedMachineTransportSelection,
): Promise<unknown> {
    if (!params.requireEncryptedPayload || transport.mode !== 'plain') return params.payload;
    const { SessionRequesterBootstrapRpcRequestV1Schema, sealSessionRequesterBootstrapRpcRequestV1 } =
        await import('@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1');
    const request = SessionRequesterBootstrapRpcRequestV1Schema.safeParse(params.payload);
    const installationId = transport.installationId;
    const publicKey = readMachineInstallationPublicKey(transport.installationPublicKey);
    if (params.method !== RPC_METHODS.SESSION_SPAWN_NEW || !request.success || !installationId || !publicKey
        || request.data.input.executionTarget.machineId !== target.machineId
        || request.data.input.executionTarget.serverId !== target.targetServerId) {
        throw createRpcCallError({ error: 'Private Machine payload requires an encrypted transport', errorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' });
    }
    if ('kind' in request.data.requesterBootstrap) {
        if (request.data.requesterBootstrap.installationId !== installationId) {
            throw createRpcCallError({ error: 'Private Machine payload has a stale installation', errorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' });
        }
        return request.data;
    }
    return sealSessionRequesterBootstrapRpcRequestV1({ request: {
        ...request.data, requesterBootstrap: request.data.requesterBootstrap,
    }, installationId, installationPublicKey: publicKey, randomBytes: getRandomBytes });
}

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
        scope: params.scope,
        timeoutMs: params.timeoutMs,
        remainingTimeoutMs: params.remainingTimeoutMs,
    });
    return error;
}

function createMachineRpcAbortError(method: string, cause?: unknown): Error {
    const error = createRpcCallError({
        error: `Machine RPC for ${method} was aborted by the caller`,
        errorCode: 'MACHINE_RPC_ABORTED',
    });
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
    waitForResultOnCancel = false,
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
                reject(signal.aborted && !(waitForResultOnCancel && socketRpcAbortScope?.issued)
                    ? createMachineRpcAbortError(method, error) : error);
            },
        );
    });
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
    const deadlineAt = Date.now() + params.timeoutMs;

    const resolveRemainingTimeoutMs = () => Math.max(0, deadlineAt - Date.now());

    return {
        resolveRemainingTimeoutMs,
        async runWithinTimeout<T>(
            scope: MachineRpcTimeoutScope,
            operation: (timeoutMs: number) => Promise<T>,
        ): Promise<T> {
            const timeoutMs = resolveRemainingTimeoutMs();
            if (timeoutMs <= 0) {
                throw createMachineRpcTimeoutError({
                    scope,
                    method: params.method,
                    timeoutMs: params.timeoutMs,
                    remainingTimeoutMs: 0,
                });
            }
            try {
                return await withMachineRpcTimeout(
                    operation(timeoutMs),
                    {
                        scope,
                        method: params.method,
                        timeoutMs,
                        totalTimeoutMs: params.timeoutMs,
                    },
                );
            } catch (error) {
                // A subordinate read uses this same deadline and can settle its
                // timeout first. The containing RPC still owns its public budget,
                // except that the pool's own timeout keeps its connection phase.
                if (isMachineRpcTimeoutError(error) && !(error instanceof ScopedRpcSocketConnectionTimeoutError)
                    && resolveRemainingTimeoutMs() <= 0) {
                    throw createMachineRpcTimeoutError({
                        scope,
                        method: params.method,
                        timeoutMs: params.timeoutMs,
                        remainingTimeoutMs: timeoutMs,
                    });
                }
                throw error;
            }
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
    params: ServerScopedMachineRpcParams<A, R>,
    socketRpcAbortScope: { issued: boolean },
    timeoutBudget: ReturnType<typeof createMachineRpcTimeoutBudget>,
    onNoEffect: () => void,
    observeScope: (scope: MachineReachabilityScope | null) => void,
    observedMachine?: MachinePublishedRowV1,
): Promise<R> {
    const configuredTimeoutMs = resolveMachineRpcTimeoutMs(params.timeoutMs);
    const guarded = isGuardedMachineRpcMethod(params.method);
    const allowDirect = guarded
        ? await timeoutBudget.runWithinTimeout('scoped', async (timeoutMs) =>
            await resolveTransferPolicyAllowsMachineRpcDirect({ serverId: params.serverId ?? undefined, timeoutMs, signal: params.signal }))
        : true;
    const policyPreferScoped = guarded && !allowDirect;
    const initialPreferScoped = params.preferScoped === true || params.requireEncryptedPayload === true || !!params.onContinuation || policyPreferScoped;
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
        const runOperation = async <T>(scope: MachineRpcTimeoutScope, operation: (timeoutMs: number | null) => Promise<T>): Promise<T> =>
            params.operationTimeoutMs === null
                ? await operation(null)
                : await timeoutBudget.runWithinTimeout(scope, operation);
        // An explicit Account pins its own connection only when the applied active socket
        // serves a different Account or Home; naming the active Account rides that socket.
        const activeRequestScope = requestedAccountId ? apiSocket.getMachineRequestScope() : null;
        const accountPinsScoped = Boolean(requestedAccountId) && !(activeRequestScope
            && activeRequestScope.accountId === requestedAccountId
            && areServerProfileIdentifiersEquivalent(activeRequestScope.serverId, requestedServerId || activeServerId));
        const preferScoped = options?.forceScoped === true || initialPreferScoped || accountPinsScoped;
        const requestedScopedContext = preferScoped
            || Boolean(requestedServerId && !areServerProfileIdentifiersEquivalent(requestedServerId, activeServerId));
        const context = await timeoutBudget.runWithinTimeout(
            requestedScopedContext ? 'scoped' : 'active',
            async (timeoutMs) =>
                await resolveServerScopedContext({
                    machineId: params.machineId,
                    serverId: params.serverId,
                    ...(requestedAccountId && preferScoped ? { accountId: requestedAccountId } : {}),
                    forceScoped: preferScoped,
                    timeoutMs,
                }),
        );
        if (params.signal?.aborted && context.scope === 'scoped') {
            await context.release?.();
        }
        throwIfMachineRpcAborted(params.method, params.signal);

        if (context.scope === 'active' && !preferScoped) {
            observeScope(apiSocket.getMachineRequestScope());
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
                        params.preparePayload?.(timeoutBudget.resolveRemainingTimeoutMs()) ?? params.payload,
                        {
                            timeoutMs,
                            ...(params.requestId ? { requestId: params.requestId } : {}),
                            ...(params.authorization ? { authorization: params.authorization } : {}),
                            onIssued: activeOnIssued,
                            ...(params.waitForResultOnCancel ? { waitForResultOnCancel: true } : {}),
                            ...(params.signal ? { signal: params.signal } : {}),
                            ...(params.readAdmission ? { readAdmission: params.readAdmission } : {}),
                            ...(params.decodeResult ? { decodeResult: params.decodeResult } : {}),
                            ...(params.onContentMode ? { onContentMode: params.onContentMode } : {}),
                            ...(requestedAccountId ? { accountId: requestedAccountId } : {}),
                        },
                    ),
                );
                return result;
            } catch (error) {
                const noEffect = readRpcErrorCode(error) === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE;
                // Only this issued call's bound refusal can retire its effect
                // uncertainty. A later preparation's notSent cannot do so.
                if (noEffect || socketRpcAbortScope.issued && readRpcRequestDisposition(error) === 'notSent') onNoEffect();
                if (params.waitForResultOnCancel && params.signal?.aborted && socketRpcAbortScope.issued) throw error;
                // A bound refusal after active issuance concerns this exact
                // Machine, not a missing local socket/key. Keep the existing
                // retry on its admitted route instead of opening a second
                // connection and re-reading the same Machine for each attempt.
                if (noEffect && socketRpcAbortScope.issued) throw error;
                if (exactIssuanceAttempted || (params.method === RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE && socketRpcAbortScope.issued)) {
                    throw error;
                }
                if (!shouldFallbackToScopedMachineRpc(error) || (socketRpcAbortScope.issued && !noEffect)) {
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

        observeScope(createServerAccountScope(context.targetServerId, context.targetAccountId ?? parseToken(context.token)));

        const releaseRequestLease = userRequestLeaseOwner.acquire();
        const setupController = new AbortController();
        const setupCancellation = mergeAbortSignals([params.signal, setupController.signal]);
        let carrierCustodyTransferred = false;
        let physicalReadOwnsCustody = false;
        const socketLifetime: { finished: boolean; client: ScopedSocketClient | null; detachDisconnect?: () => void } = { finished: false, client: null };
        const releaseCustody = async () => {
            socketLifetime.finished = true;
            // The existing setup deadline/terminal path owns this work too:
            // retiring a caller must not leave key opening queued afterward.
            setupController.abort();
            setupCancellation.dispose();
            socketLifetime.detachDisconnect?.();
            socketLifetime.detachDisconnect = undefined;
            try { socketLifetime.client?.disconnect(); }
            finally {
                try { if (!carrierCustodyTransferred) await context.release?.(); }
                finally { releaseRequestLease(); }
            }
        };
        let machineRowsPreparation: PreparedMachineRows | undefined;
        try {
            const credentials = context.credentials;
            // A row obtained with an older bearer cannot open transport for its replacement.
            const machineForTransport = observedMachine && requireMachineTransportRow(
                params.exactHomeMachineAdmission && resolveAuthCredentialsScopeKey(params.exactHomeMachineAdmission.credentials)
                    === resolveAuthCredentialsScopeKey(credentials ?? { token: context.token })
                    ? observedMachine : null,
            );
            // On Sync's own applied Home, Account and credential, its push-maintained
            // Machine projection is the authority the same Home would serve: no row read.
            const projected = await timeoutBudget.runWithinTimeout('scoped', async () =>
                await apiSocket.captureBoundMachineRpcContent({
                    serverId: context.targetServerId, accountId: context.targetAccountId,
                    credentials: credentials ?? { token: context.token },
                }, context.machineId, setupCancellation.signal));
            if (projected?.kind === 'locked') {
                // Sync refused this Machine (lock, downgrade pin, non-ready access). Re-reading
                // the row from the same Home would re-admit exactly what Sync refused.
                throw createRpcCallError({ error: `Machine encryption not found for ${context.machineId}`,
                    errorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' });
            }
            // The exact captured transport is known now; register before the
            // independent runner-trust preparation can yield to ready peers.
            machineRowsPreparation = !machineForTransport && !projected && context.readTransport
                ? prepareMachineRows({ readTransport: context.readTransport, signal: setupCancellation.signal }) : undefined;
            // Authentication/socket readiness does not depend on opening Machine content.
            // Both preparations consume the same caller deadline; no RPC is emitted until
            // the fresh key/access checks below have admitted its exact content context.
            let rejectSocketDisconnect!: (error: unknown) => void;
            const socketDisconnected = new Promise<never>((_resolve, reject) => { rejectSocketDisconnect = reject; });
            const socketRead = timeoutBudget.runWithinTimeout('scoped', async (timeoutMs) =>
                await createEphemeralServerSocketClient({ ...createScopedSocketConnectParams({ ...context, timeoutMs }, () => {
                    // Acquisition can resume after an awaited pool teardown. A retired
                    // preparation cannot transfer an already-released carrier then.
                    if (socketLifetime.finished) throw createMachineRpcAbortError(params.method);
                    carrierCustodyTransferred = true;
                    return context.release;
                }), signal: setupCancellation.signal }).then((client) => {
                    if (socketLifetime.finished) client.disconnect();
                    else {
                        socketLifetime.client = client;
                        const onDisconnect = (reason?: unknown) => rejectSocketDisconnect(Object.assign(createRpcCallError({
                            error: 'Scoped RPC socket disconnected during Machine preparation',
                            errorCode: 'MACHINE_RPC_UNREACHABLE',
                        }), { cause: reason }));
                        client.on('disconnect', onDisconnect);
                        socketLifetime.detachDisconnect = () => client.off('disconnect', onDisconnect);
                        if (client.connected === false) onDisconnect();
                    }
                    return client;
                }));
            const machinePreparation = projected ? (async () => {
                const requestPayload = await prepareScopedMachineRequestPayload(params, context, projected);
                if (socketLifetime.finished) throw createMachineRpcAbortError(params.method);
                throwIfMachineRpcAborted(params.method, params.signal);
                return { machineTransport: projected, isMachineCurrent: projected.isCurrent, isDispatchCurrent: projected.isCurrent,
                    usePlaintextTransport: projected.mode === 'plain', requestPayload, machineEncryption: projected.cipher,
                    bindingKey: ['projection', ...projected.bindingKey], readScope: projected.readScope };
            })() : (async () => {
                const runnerTrust = credentials
                    ? await timeoutBudget.runWithinTimeout('scoped', async () => await resolveRunnerMachineContentKeyTrustV1({
                        credentials,
                        homeServerIdentityId: context.targetServerId,
                        machineId: context.machineId,
                    }))
                    : null;
                if (socketLifetime.finished) throw createMachineRpcAbortError(params.method);
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
                        accountE2eeCustody: readAccountE2eeCustody(credentials ?? { token: context.token }),
                        signal: setupCancellation.signal,
                        readTransport: context.readTransport,
                        preparedMachineRows: machineRowsPreparation,
                        observedMachine: machineForTransport,
                        readAccountMode: async () => {
                            const request = createServerRequestForExplicitServerScope({
                                serverUrl: context.targetServerUrl, token: context.token,
                                serverId: context.targetServerId, credentials,
                                accountEncryptionObservation: context.accountEncryptionObservation,
                                runtimeOrigin: context.runtimeOrigin, homeCarrier: context.homeCarrier, timeoutMs,
                            });
                            return (await fetchAccountEncryptionMode(credentials ?? { token: context.token }, {
                                request, signal: setupCancellation.signal, usage: 'identity',
                            })).mode;
                        },
                        ...(runnerTrust ? { expectedRunnerBinding: runnerTrust.expectedRunnerBinding } : {}),
                        ...(runnerTrust?.trustedMachineKind
                            ? { trustedMachineKind: runnerTrust.trustedMachineKind }
                            : {}),
                        timeoutMs,
                        ...(context.encryption
                            ? {
                                decryptEncryptionKey: (value: string) =>
                                    context.encryption!.decryptEncryptionKey(value, {
                                        signal: setupCancellation.signal,
                                        workClass: 'interactive',
                                        shouldContinue: () => !socketLifetime.finished,
                                    }),
                                encryption: context.encryption,
                            }
                            : {}),
                        }),
                );
                throwIfMachineRpcAborted(params.method, params.signal);
                if (socketLifetime.finished) throw createMachineRpcAbortError(params.method);

                if (!machineTransport || (machineTransport.mode === 'e2ee' && !runnerTrust)) {
                    await context.encryption?.initializeMachines(new Map(), new Set([context.machineId]));
                    throw createRpcCallError({
                        error: `Machine encryption not found for ${context.machineId}`,
                        errorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE',
                    });
                }
                const usePlaintextTransport = machineTransport.mode === 'plain';
                const requestPayload = await prepareScopedMachineRequestPayload(params, context, machineTransport);
                if (socketLifetime.finished) throw createMachineRpcAbortError(params.method);
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
                        ]]), undefined, { isMachineCurrent: () => !socketLifetime.finished && isMachineCurrent() });
                            return undefined;
                        },
                    );
                    machineEncryption = context.encryption.getMachineEncryption(context.machineId);
                    if (!machineEncryption || !isMachineCurrent()) {
                        throw new Error(`Machine encryption not found for ${context.machineId}`);
                    }
                }
                throwIfMachineRpcAborted(params.method, params.signal);
                const isDispatchCurrent = () => isMachineCurrent()
                    && (usePlaintextTransport || context.encryption?.getMachineEncryption(context.machineId) === machineEncryption);
                return { machineTransport, isMachineCurrent, isDispatchCurrent, usePlaintextTransport, requestPayload, machineEncryption,
                    bindingKey: [] as unknown[], readScope: [machineTransport.readScope ?? machineTransport.context ?? context] };
            })();
            // Both preparations are required, but either can definitively fail.
            // Observe that failure now, not after an unrelated sibling reaches
            // the setup deadline and replaces its real transport cause.
            const [socket, { machineTransport, isMachineCurrent, isDispatchCurrent, usePlaintextTransport, requestPayload, machineEncryption,
                bindingKey, readScope }] =
                await Promise.race([Promise.all([socketRead, machinePreparation]), socketDisconnected]);
            socketLifetime.detachDisconnect?.();
            socketLifetime.detachDisconnect = undefined;
            throwIfMachineRpcAborted(params.method, params.signal);
            params.onContentMode?.(usePlaintextTransport ? 'plain' : 'e2ee');
            // From this point the RPC cancellation/ACK owner retains custody.
            // A later caller abort must not release its pooled socket early.
            setupCancellation.dispose();
            return await runAdmittedMachineRpcRead({
                admission: params.readAdmission,
                decodeResult: params.decodeResult,
                signal: params.signal,
                binding: {
                    key: JSON.stringify([context.targetServerId, context.targetServerUrl, context.runtimeOrigin ?? null,
                        context.carrier ?? null, context.homeCarrier?.endpointId ?? null,
                        resolveAuthCredentialsScopeKey(credentials ?? { token: context.token }),
                        context.readTransport?.key ?? null, machineTransport.mode,
                        machineTransport.installationId ?? null, machineTransport.installationPublicKey ?? null, ...bindingKey]),
                    scope: readScope,
                    assertCurrent: () => {
                        if (!isMachineCurrent()) throw createRpcCallError({
                            error: 'Machine encryption context changed before read admission', errorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE',
                        });
                    },
                },
                onPhysicalAcquire: () => {
                    physicalReadOwnsCustody = true;
                    return releaseCustody;
                },
                onIssued: () => {
                    onIssued?.();
                    socketRpcAbortScope.issued = true;
                    params.onDispatched?.();
                },
                resolve: async (sharedSignal, notifyIssued) => await runOperation(
                'scoped',
                async (timeoutMs) => {
                    try {
                        return await callSocketRpc<R>({
                            randomBytes: getRandomBytes,
                            socket,
                            target: { kind: 'machine', id: context.machineId },
                            method: params.method,
                            params: params.preparePayload?.(timeoutBudget.resolveRemainingTimeoutMs()) ?? requestPayload,
                            content: usePlaintextTransport
                                ? { mode: 'plain' }
                                : {
                                    mode: 'e2ee',
                                    responseContentVersion: 1,
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
                            onContinuation: params.onContinuation,
                            requestId: params.requestId,
                            onIssued: () => {
                                if (params.operationTimeoutMs !== null && timeoutBudget.resolveRemainingTimeoutMs() <= 0) {
                                    throw createMachineRpcTimeoutError({ scope: 'scoped', method: params.method,
                                        timeoutMs: configuredTimeoutMs, remainingTimeoutMs: 0 });
                                }
                                if (!isDispatchCurrent()) {
                                    throw createRpcCallError({ error: 'Machine encryption context changed before dispatch', errorCode: 'MACHINE_ENCRYPTION_UNAVAILABLE' });
                                }
                                notifyIssued();
                            },
                            signal: sharedSignal,
                            ...(params.waitForResultOnCancel ? { waitForResultOnCancel: true } : {}),
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
                ),
            });
        } finally {
            machineRowsPreparation?.release();
            if (!physicalReadOwnsCustody) await releaseCustody();
        }
    };

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await withMachineRpcAbort(params.method, params.signal, () => runOnce(), socketRpcAbortScope, params.waitForResultOnCancel);
        } catch (error) {
            lastError = error;
            const rpcErrorCode = readRpcErrorCode(error);
            if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
                || socketRpcAbortScope.issued && readRpcRequestDisposition(error) === 'notSent') onNoEffect();
            if (params.method === RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE && socketRpcAbortScope.issued) {
                throw createPrivateContinuationTransportError(error, true);
            }
            if (params.signal?.aborted) {
                if (params.waitForResultOnCancel && socketRpcAbortScope.issued) throw error;
                throw createMachineRpcAbortError(params.method, error);
            }
            if (exactIssuanceAttempted || params.onContinuation && socketRpcAbortScope.issued) {
                throw error;
            }
            if (rpcErrorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE && attempt === 0) {
                await timeoutBudget.runWithinTimeout('scoped', async (timeoutMs) => await delay(Math.min(250, timeoutMs)));
                continue;
            }
            throw error;
        }
    }
    throw lastError ?? new Error('Machine RPC failed');
}

export async function machineRpcWithServerScope<R, A>(params: ServerScopedMachineRpcParams<A, R>): Promise<R> {
    // One caller budget covers route discovery, setup, fallback and retries.
    // Caller-owned operation lifetimes still bound setup but not the RPC reply.
    const timeoutBudget = createMachineRpcTimeoutBudget({
        method: params.method,
        timeoutMs: resolveMachineRpcTimeoutMs(params.timeoutMs),
    });
    let observedMachine: MachinePublishedRowV1 | undefined;
    const admission = params.exactHomeMachineAdmission;
    if (admission) {
        const preparation = new AbortController();
        const cancellation = mergeAbortSignals([params.signal, preparation.signal]);
        try {
            const row = await withMachineRpcAbort(params.method, cancellation.signal, () =>
                timeoutBudget.runWithinTimeout('scoped', () => admission.readRow(cancellation.signal)));
            observedMachine = requireMachineTransportRow(row);
            assertMachineNotReportedOfflineV1(observedMachine);
        } catch (error) {
            // A rejected admission is not evidence that a Machine request failed.
            if (!cancellation.signal.aborted) admission.onRejected(error);
            throw markRpcRequestDisposition(error, 'notSent');
        } finally {
            preparation.abort();
            cancellation.dispose();
        }
    }
    // Peer mediation, relay policy, and the server fallback must all use the
    // Home that owns this execution. During a Home handoff, `serverRuntime`
    // may already describe the next staged Home while the applied runtime
    // still serves the incumbent.
    const effectiveServerId = resolveMachineRpcTargetServerId(params.serverId);
    let requestMayHaveEffects = false;
    const activeScope = apiSocket.getMachineRequestScope();
    const requestEvidence: { scope: MachineReachabilityScope | null } = {
        scope: activeScope && areServerProfileIdentifiersEquivalent(activeScope.serverId, effectiveServerId)
            && (!params.accountId || params.accountId === activeScope.accountId) ? activeScope : null,
    };
    let observePresence = captureMachinePresenceObservation(requestEvidence.scope);
    const observeScope = (scope: MachineReachabilityScope | null) => {
        requestEvidence.scope = scope;
        observePresence = captureMachinePresenceObservation(scope);
    };
    const onNoEffect = () => { requestMayHaveEffects = false; };
    const effectiveParams: ServerScopedMachineRpcParams<A, R> = {
        ...params,
        // The default budget bounds connection/setup, not remote operation work.
        // Explicit caller deadlines still cover the complete invocation.
        ...(params.timeoutMs === undefined ? { operationTimeoutMs: null } : {}),
        serverId: effectiveServerId || undefined,
        onDispatched: () => {
            requestMayHaveEffects = true;
            params.onDispatched?.();
        },
    };
    const socketRpcAbortScope = { issued: false };

    try {
        const result = effectiveParams.onIssued || effectiveParams.requireEncryptedPayload || effectiveParams.waitForResultOnCancel
            || effectiveParams.onContentMode || effectiveParams.onContinuation
            ? await machineRpcWithServerTransport<R, A>(effectiveParams, socketRpcAbortScope, timeoutBudget, onNoEffect, observeScope, observedMachine)
            : await withMachineRpcAbort(
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
                    ...(effectiveParams.requestId ? { createRequestId: () => effectiveParams.requestId! } : {}),
                    signal: effectiveParams.signal,
                    onDispatched: effectiveParams.onDispatched,
                    onDirectRefused: onNoEffect,
                    readAdmission: effectiveParams.readAdmission,
                    decodeResult: effectiveParams.decodeResult,
                    resolveDirectRoute: async (input) => await timeoutBudget.runWithinTimeout('scoped', async (timeoutMs) => {
                        const route = await resolveProductionMachineRpcDirectRoute({
                            ...input,
                            serverId: effectiveParams.serverId,
                            timeoutMs,
                            resolveRemainingTimeoutMs: timeoutBudget.resolveRemainingTimeoutMs,
                            signal: effectiveParams.signal,
                        });
                        if (route.kind === 'selected') {
                            observeScope(createServerAccountScope(
                                resolveServerProfileScopeIdForIdentifier(effectiveParams.serverId), route.grant.payload.accountId,
                            ));
                        }
                        return route;
                    }),
                    postDirect: async (directInput) => {
                        const response = await withMachineRpcAbort(
                            effectiveParams.method,
                            directInput.signal,
                            () => effectiveParams.operationTimeoutMs === null
                                ? postProductionMachineRpcDirect(directInput)
                                : timeoutBudget.runWithinTimeout('scoped', async (timeoutMs) =>
                                    await postProductionMachineRpcDirect({ ...directInput, timeoutMs })),
                        );
                        return response;
                    },
                    recordReceipt: recordMachineRpcPeerMediationReceipt,
                    resolveRelayFallback: async (input) => await timeoutBudget.runWithinTimeout('scoped', async (timeoutMs) =>
                        await resolveProductionMachineRpcRelayFallbackForServer({
                            policy: input.policy,
                            serverId: effectiveParams.serverId,
                            timeoutMs,
                        })),
                    serverFallback: async (fallbackInput) => await machineRpcWithServerTransport<R, A>({
                        ...effectiveParams,
                        machineId: fallbackInput.machineId,
                        method: fallbackInput.method,
                        payload: fallbackInput.payload,
                        accountId: fallbackInput.accountId,
                        timeoutMs: fallbackInput.timeoutMs,
                        authorization: fallbackInput.authorization,
                    }, socketRpcAbortScope, timeoutBudget, onNoEffect, observeScope, observedMachine),
                }),
                socketRpcAbortScope,
                effectiveParams.waitForResultOnCancel,
            );
        if (requestEvidence.scope) {
            // An authenticated reply is fresh presence for this exact Machine.
            // Capture before dispatch so a later withdrawal fences old replies.
            observePresence([effectiveParams.machineId]);
            recordMachineRequestSucceeded({
                ...requestEvidence.scope,
                machineId: effectiveParams.machineId,
            });
        }
        return result;
    } catch (error) {
        // Attempt-local notSent cannot erase an earlier unresolved dispatch.
        // Only a bound pre-effect refusal clears that invocation-wide fact.
        const witnessedError = requestMayHaveEffects || readRpcRequestDisposition(error) === null
            ? markRpcRequestDisposition(error, requestMayHaveEffects ? 'outcomeUnknown' : 'notSent')
            : error;
        if (requestEvidence.scope && isMachineRequestReachabilityFailure(error)) {
            recordMachineRequestFailed({
                ...requestEvidence.scope,
                machineId: effectiveParams.machineId,
            });
        }
        throw witnessedError;
    }
}

/** Order asynchronous preparation through actual dispatch, never through RPC replies. */
export function createOrderedMachineRpcCaller(
    call: typeof machineRpcWithServerScope = machineRpcWithServerScope,
): typeof machineRpcWithServerScope {
    let dispatchTail = Promise.resolve();
    return async <R, A>(params: ServerScopedMachineRpcParams<A, R>): Promise<R> => {
        const previous = dispatchTail;
        let releaseDispatch!: () => void;
        const dispatched = new Promise<void>((resolve) => { releaseDispatch = resolve; });
        // A cancelled waiter must not let its successor overtake the previous dispatch.
        dispatchTail = previous.then(() => dispatched);
        const abortScope = { issued: false };
        try {
            return await withMachineRpcAbort(params.method, params.signal, async () => {
                await previous;
                throwIfMachineRpcAborted(params.method, params.signal);
                return await call<R, A>({
                    ...params,
                    onDispatched: () => {
                        abortScope.issued = true;
                        releaseDispatch();
                        params.onDispatched?.();
                    },
                });
            }, params.waitForResultOnCancel ? abortScope : undefined, params.waitForResultOnCancel);
        } finally {
            // Setup failure or cancellation must release the admission fence as well.
            releaseDispatch();
        }
    };
}
