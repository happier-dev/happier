import { countDuplicateLocalIds, fetchAllMessages } from '../../sessions';
import { sleep, waitFor } from '../../timing';
import type { StressConfig } from '../config/stressScenarioSchema';
import { resolveRpcCallCount } from './stressScenarioRuntime';
import { runStressTasksWithConcurrencyLimit } from './runStressTasksWithConcurrencyLimit';
import { waitForRegisteredRpcMethod } from './waitForRegisteredRpcMethod';
import type { MixedRealisticWorkload } from './mixedRealisticWorkload';
import {
    emitPresencePulse,
    resolveMixedConnectConvergenceTimeoutMs,
    resolveMixedControlPlaneBaseUrlForIndex,
    resolvePrimaryMixedUserDevice,
    sendMixedMessageBatch,
    sendMixedRpcBatch,
    sendMixedTranscriptStreamBatch,
    type MixedCollector,
    type MixedSessionTarget,
    type MixedUserDevices,
} from './mixedScenarioShared';

type MixedListener = Readonly<{
    method: string;
    machineId: string;
    authIndex: number;
    socket: MixedCollector['socket'];
}>;

type MixedRpcPlan = Readonly<{
    listenerIndex: number;
    triggerMessageIndex: number;
}>;

export type MixedRpcReadinessLedgerEntry = Readonly<{
    method: string;
    machineId: string;
    authIndex: number;
    status: 'ok' | 'error';
    durationMs: number;
    error?: string;
}>;

export type MixedFailedRpcContext = Readonly<{
    method: string;
    machineId: string;
    authIndex: number;
    rpcCallsCompleted: number;
    messagesSentBeforeFailure: number;
    errorCode?: string;
    error?: string;
}>;

export type MixedTrafficFailureContext = Readonly<{
    stage: 'rpc_register' | 'rpc_readiness' | 'message_batch' | 'rpc_batch' | 'reconnect' | 'stream_dispatch' | 'verification';
    error: string;
    method?: string;
    machineId?: string;
    authIndex?: number;
    sessionId?: string;
    batchStart?: number;
    batchEndExclusive?: number;
    rpcCallsCompleted: number;
    messagesSentBeforeFailure: number;
    reconnectsTriggered: number;
    rpcReadinessProbed: number;
    rpcReadinessFailed: number;
}>;

export type MixedRealisticTrafficResult = Readonly<{
    listeners: readonly MixedListener[];
    rpcReadinessLedger: readonly MixedRpcReadinessLedgerEntry[];
    failedRpc?: MixedFailedRpcContext;
    trafficFailure?: MixedTrafficFailureContext;
    ackLatencies: number[];
    rpcLatencies: number[];
    streamDispatchLatencies: number[];
    duplicateLocalIds: number;
    messageAckFailures: number;
    rpcFailures: number;
    reconnectFailures: number;
    reconnectsTriggered: number;
    rpcCalls: number;
    streamSegmentsSent: number;
    stageDurationsMs: {
        connectMs: number;
        trafficMs: number;
        verificationMs: number;
    };
}>;

function selectReadinessProbeListeners(
    listeners: readonly MixedListener[],
    probeCount: number,
): readonly MixedListener[] {
    if (listeners.length === 0) {
        return [];
    }
    if (probeCount >= listeners.length) {
        return listeners;
    }

    const selected = new Map<number, MixedListener>();
    const lastIndex = listeners.length - 1;
    for (let index = 0; index < probeCount; index += 1) {
        const offset = Math.round((index * lastIndex) / Math.max(1, probeCount - 1));
        const listener = listeners[offset];
        if (listener) {
            selected.set(offset, listener);
        }
    }

    return Array.from(selected.values());
}

export async function runMixedRealisticTraffic(params: Readonly<{
    baseUrl: string;
    controlPlaneBaseUrl?: string;
    controlPlaneBaseUrls?: readonly string[];
    config: StressConfig;
    workload: MixedRealisticWorkload;
    authIndexOffset?: number;
    userDevices: readonly MixedUserDevices[];
    sessions: readonly MixedSessionTarget[];
    machineCollectors: readonly MixedCollector[];
    verificationSessionIds: readonly string[];
    verificationSessionTokensBySessionId: ReadonlyMap<string, string>;
    expectedLocalIdsBySession: Map<string, string[]>;
}>): Promise<MixedRealisticTrafficResult> {
    const authIndexOffset = params.authIndexOffset ?? 0;
    const mixedRpcRegistrationConcurrency = params.config.load.mixedRpcRegistrationConcurrency ?? 8;
    const mixedRpcBatchConcurrency = params.config.load.mixedRpcBatchConcurrency ?? 32;
    const mixedPresencePulseConcurrency = params.config.load.mixedPresencePulseConcurrency ?? 32;
    const mixedMessageBatchConcurrency = params.config.load.mixedMessageBatchConcurrency ?? 32;
    const ackLatencies: number[] = [];
    const rpcLatencies: number[] = [];
    const streamDispatchLatencies: number[] = [];
    const rpcReadinessLedger: MixedRpcReadinessLedgerEntry[] = [];
    let failedRpc: MixedFailedRpcContext | undefined;
    let trafficFailure: MixedTrafficFailureContext | undefined;
    let messageAckFailures = 0;
    let rpcFailures = 0;
    let reconnectFailures = 0;
    let duplicateLocalIds = 0;
    let reconnectsTriggered = 0;
    let rpcCalls = 0;
    let streamSegmentsSent = 0;
    const stageDurationsMs = {
        connectMs: 0,
        trafficMs: 0,
        verificationMs: 0,
    };

    const trafficSessions = params.sessions.slice(0, Math.min(params.sessions.length, params.workload.activeSessionCount));
    const trafficCollectors = params.machineCollectors.slice(0, Math.min(params.machineCollectors.length, params.workload.activeSessionCount));
    const listeners = trafficCollectors.slice(0, Math.min(trafficCollectors.length, params.workload.rpcListenerCount)).map((collector, index) => ({
        method: `${collector.sessionId}:stress.mixed.rpc.${index}`,
        machineId: collector.machineId,
        authIndex: collector.authIndex,
        socket: collector.socket,
    })) satisfies MixedListener[];
    const reconnectPool = trafficCollectors.slice(listeners.length);

    if (trafficSessions.length === 0) {
        return {
            listeners,
            rpcReadinessLedger,
            ackLatencies,
            rpcLatencies,
            streamDispatchLatencies,
            duplicateLocalIds,
            messageAckFailures,
            rpcFailures,
            reconnectFailures,
            reconnectsTriggered,
            rpcCalls,
            streamSegmentsSent,
            stageDurationsMs,
        };
    }

    function setTrafficFailureIfAbsent(nextFailure: MixedTrafficFailureContext): void {
        if (!trafficFailure) {
            trafficFailure = nextFailure;
        }
    }

    try {
        const connectStartedAt = Date.now();
        await runStressTasksWithConcurrencyLimit(listeners, mixedRpcRegistrationConcurrency, async (listener) => {
            listener.socket.onRpcRequest(async () => JSON.stringify({ ok: true, machineId: listener.machineId }));
            try {
                await listener.socket.rpcRegister(listener.method);
            } catch (error) {
                setTrafficFailureIfAbsent({
                    stage: 'rpc_register',
                    method: listener.method,
                    machineId: listener.machineId,
                    authIndex: listener.authIndex,
                    rpcCallsCompleted: rpcCalls,
                    messagesSentBeforeFailure: ackLatencies.length,
                    reconnectsTriggered,
                    rpcReadinessProbed: rpcReadinessLedger.length,
                    rpcReadinessFailed: rpcReadinessLedger.filter((entry) => entry.status === 'error').length,
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        });

        const readinessProbeListeners = selectReadinessProbeListeners(listeners, params.workload.rpcReadinessProbeCount);
        await Promise.all(
            readinessProbeListeners.map(async (listener) => {
                const startedAt = Date.now();
                try {
                    await waitForRegisteredRpcMethod({
                        ui: resolvePrimaryMixedUserDevice({
                            userDevices: params.userDevices,
                            authIndex: listener.authIndex,
                        }),
                        method: listener.method,
                        expectedMachineId: listener.machineId,
                    });
                    rpcReadinessLedger.push({
                        method: listener.method,
                        machineId: listener.machineId,
                        authIndex: listener.authIndex,
                        status: 'ok',
                        durationMs: Date.now() - startedAt,
                    });
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    rpcReadinessLedger.push({
                        method: listener.method,
                        machineId: listener.machineId,
                        authIndex: listener.authIndex,
                        status: 'error',
                        durationMs: Date.now() - startedAt,
                        error: errorMessage,
                    });
                    setTrafficFailureIfAbsent({
                        stage: 'rpc_readiness',
                        method: listener.method,
                        machineId: listener.machineId,
                        authIndex: listener.authIndex,
                        rpcCallsCompleted: rpcCalls,
                        messagesSentBeforeFailure: ackLatencies.length,
                        reconnectsTriggered,
                        rpcReadinessProbed: rpcReadinessLedger.length,
                        rpcReadinessFailed: rpcReadinessLedger.filter((entry) => entry.status === 'error').length,
                        error: errorMessage,
                    });
                    throw error;
                }
            }),
        );
        stageDurationsMs.connectMs = Date.now() - connectStartedAt;

        if (params.workload.presencePulseCollectorCount > 0) {
            await runStressTasksWithConcurrencyLimit(
                params.machineCollectors.slice(0, params.workload.presencePulseCollectorCount),
                mixedPresencePulseConcurrency,
                async (collector) => {
                    await emitPresencePulse(collector);
                },
            );
        }

        const trafficStartedAt = Date.now();
        const mixedUserDeviceReconnectTimeoutMs = resolveMixedConnectConvergenceTimeoutMs(params.config);
        const plannedRpcCalls = resolveRpcCallCount(params.config, listeners.length);
        const rpcEveryMessages = Math.max(1, Math.floor(params.workload.messageCount / Math.max(1, plannedRpcCalls)));
        const reconnectEveryMessages = Math.max(1, Math.floor(params.workload.messageCount / Math.max(1, params.workload.reconnectCycles)));
        let reconnectIndex = 0;
        let nextRpcTrigger = rpcEveryMessages;
        let nextReconnectTrigger = reconnectEveryMessages;

        for (let batchStart = 0; batchStart < params.workload.messageCount; batchStart += mixedMessageBatchConcurrency) {
            const batchEndExclusive = Math.min(params.workload.messageCount, batchStart + mixedMessageBatchConcurrency);
            const acknowledgedBeforeBatch = ackLatencies.length;
            try {
                await sendMixedMessageBatch({
                    startIndex: batchStart,
                    endIndexExclusive: batchEndExclusive,
                    sessions: trafficSessions,
                    concurrency: mixedMessageBatchConcurrency,
                    userDevices: params.userDevices,
                    ackLatencies,
                    expectedLocalIdsBySession: params.expectedLocalIdsBySession,
                    reconnectTimeoutMs: mixedUserDeviceReconnectTimeoutMs,
                });
            } catch (error) {
                messageAckFailures += Math.max(1, ackLatencies.length - acknowledgedBeforeBatch);
                setTrafficFailureIfAbsent({
                    stage: 'message_batch',
                    batchStart,
                    batchEndExclusive,
                    rpcCallsCompleted: rpcCalls,
                    messagesSentBeforeFailure: ackLatencies.length,
                    reconnectsTriggered,
                    rpcReadinessProbed: rpcReadinessLedger.length,
                    rpcReadinessFailed: rpcReadinessLedger.filter((entry) => entry.status === 'error').length,
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }

            const dueRpcPlans: MixedRpcPlan[] = [];
            while (
                listeners.length > 0
                && rpcCalls + dueRpcPlans.length < plannedRpcCalls
                && nextRpcTrigger <= batchEndExclusive
            ) {
                dueRpcPlans.push({
                    listenerIndex: (rpcCalls + dueRpcPlans.length) % listeners.length,
                    triggerMessageIndex: nextRpcTrigger - 1,
                });
                nextRpcTrigger += rpcEveryMessages;
            }

            if (dueRpcPlans.length > 0) {
                const completedRpcCallsBeforeBatch = rpcLatencies.length;
                try {
                    await sendMixedRpcBatch({
                        listeners,
                        rpcPlans: dueRpcPlans,
                        concurrency: mixedRpcBatchConcurrency,
                        userDevices: params.userDevices,
                        rpcLatencies,
                        reconnectTimeoutMs: mixedUserDeviceReconnectTimeoutMs,
                    });
                    rpcCalls += dueRpcPlans.length;
                } catch (error) {
                    rpcFailures += 1;
                    const failureMessage = error instanceof Error ? error.message : String(error);
                    const failedMethod = /Mixed workload RPC (?:failed for|routed to the wrong listener for) (.+?)(?:: .+)?$/u.exec(failureMessage)?.[1];
                    const failedListener = listeners.find((listener) => listener.method === failedMethod);
                    const completedRpcCallsThisBatch = Math.max(0, rpcLatencies.length - completedRpcCallsBeforeBatch);
                    failedRpc = {
                        method: failedListener?.method ?? failedMethod ?? 'unknown',
                        machineId: failedListener?.machineId ?? 'unknown',
                        authIndex: failedListener?.authIndex ?? -1,
                        rpcCallsCompleted: rpcCalls + completedRpcCallsThisBatch,
                        messagesSentBeforeFailure: ackLatencies.length,
                        ...(failureMessage.includes('RPC_METHOD_NOT_AVAILABLE') ? { errorCode: 'RPC_METHOD_NOT_AVAILABLE' } : {}),
                        error: failureMessage,
                    };
                    setTrafficFailureIfAbsent({
                        stage: 'rpc_batch',
                        method: failedListener?.method ?? failedMethod,
                        machineId: failedListener?.machineId,
                        authIndex: failedListener?.authIndex,
                        rpcCallsCompleted: rpcCalls + completedRpcCallsThisBatch,
                        messagesSentBeforeFailure: ackLatencies.length,
                        reconnectsTriggered,
                        rpcReadinessProbed: rpcReadinessLedger.length,
                        rpcReadinessFailed: rpcReadinessLedger.filter((entry) => entry.status === 'error').length,
                        error: failureMessage,
                    });
                    throw error;
                }
            }

            while (reconnectsTriggered < params.workload.reconnectCycles && nextReconnectTrigger <= batchEndExclusive) {
                const collectorPool = reconnectPool.length > 0 ? reconnectPool : params.machineCollectors;
                const collector = collectorPool[reconnectIndex % collectorPool.length];
                reconnectIndex += 1;
                if (!collector) {
                    throw new Error(`Missing reconnect collector at index ${reconnectIndex}`);
                }
                try {
                    collector.socket.disconnect();
                    await waitFor(() => !collector.socket.isConnected(), { timeoutMs: 20_000 });
                    collector.socket.connect();
                    await waitFor(() => collector.socket.isConnected(), { timeoutMs: 30_000 });
                    const reconnectingListener = listeners.find((listener) => listener.machineId === collector.machineId);
                    if (reconnectingListener) {
                        await reconnectingListener.socket.rpcRegister(reconnectingListener.method);
                        await waitForRegisteredRpcMethod({
                            ui: resolvePrimaryMixedUserDevice({
                                userDevices: params.userDevices,
                                authIndex: reconnectingListener.authIndex,
                            }),
                            method: reconnectingListener.method,
                            expectedMachineId: reconnectingListener.machineId,
                        });
                    }
                    if (params.workload.presencePulseCollectorCount > 0) {
                        await emitPresencePulse(collector);
                    }
                } catch (error) {
                    const reconnectingListener = listeners.find((listener) => listener.machineId === collector.machineId);
                    setTrafficFailureIfAbsent({
                        stage: 'reconnect',
                        method: reconnectingListener?.method,
                        machineId: collector.machineId,
                        authIndex: collector.authIndex,
                        rpcCallsCompleted: rpcCalls,
                        messagesSentBeforeFailure: ackLatencies.length,
                        reconnectsTriggered,
                        rpcReadinessProbed: rpcReadinessLedger.length,
                        rpcReadinessFailed: rpcReadinessLedger.filter((entry) => entry.status === 'error').length,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    throw error;
                }
                reconnectsTriggered += 1;
                nextReconnectTrigger += reconnectEveryMessages;

                if (reconnectsTriggered % 2 === 0) {
                    const reconnectUserDevice = resolvePrimaryMixedUserDevice({
                        userDevices: params.userDevices,
                        authIndex: collector.authIndex,
                    });
                    reconnectUserDevice.disconnect();
                    await waitFor(() => !reconnectUserDevice.isConnected(), { timeoutMs: 20_000 });
                    reconnectUserDevice.connect();
                    await waitFor(() => reconnectUserDevice.isConnected(), { timeoutMs: 30_000 });
                }
            }
        }

        if (params.workload.streamSegmentCount > 0 && trafficCollectors.length > 0) {
            for (let batchStart = 0; batchStart < params.workload.streamSegmentCount; batchStart += mixedMessageBatchConcurrency) {
                const batchEndExclusive = Math.min(params.workload.streamSegmentCount, batchStart + mixedMessageBatchConcurrency);
                try {
                    await sendMixedTranscriptStreamBatch({
                        startIndex: batchStart,
                        endIndexExclusive: batchEndExclusive,
                        collectors: trafficCollectors,
                        concurrency: mixedMessageBatchConcurrency,
                        streamDispatchLatencies,
                    });
                } catch (error) {
                    setTrafficFailureIfAbsent({
                        stage: 'stream_dispatch',
                        batchStart,
                        batchEndExclusive,
                        rpcCallsCompleted: rpcCalls,
                        messagesSentBeforeFailure: ackLatencies.length,
                        reconnectsTriggered,
                        rpcReadinessProbed: rpcReadinessLedger.length,
                        rpcReadinessFailed: rpcReadinessLedger.filter((entry) => entry.status === 'error').length,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    throw error;
                }
                streamSegmentsSent += batchEndExclusive - batchStart;
            }
        }

        if (params.config.duration.soakMs > 0) {
            await sleep(params.config.duration.soakMs);
        }
        stageDurationsMs.trafficMs = Date.now() - trafficStartedAt;

        const verificationStartedAt = Date.now();
        for (const sessionId of params.verificationSessionIds) {
            const session = params.sessions.find((candidate) => candidate.sessionId === sessionId);
            if (!session) {
                throw new Error(`Missing mixed session ownership for ${sessionId}`);
            }
            const verificationToken = params.verificationSessionTokensBySessionId.get(sessionId);
            if (!verificationToken) {
                throw new Error(`Missing verification token for ${sessionId}`);
            }
            try {
                const controlPlaneBaseUrl = resolveMixedControlPlaneBaseUrlForIndex({
                    baseUrl: params.baseUrl,
                    controlPlaneBaseUrl: params.controlPlaneBaseUrl,
                    controlPlaneBaseUrls: params.controlPlaneBaseUrls,
                    index: session.authIndex,
                });
                const transcript = await fetchAllMessages(
                    controlPlaneBaseUrl,
                    verificationToken,
                    sessionId,
                );
                duplicateLocalIds += countDuplicateLocalIds(transcript);
                const localIdSet = new Set(
                    transcript
                        .map((message) => message.localId)
                        .filter((value): value is string => typeof value === 'string' && value.length > 0),
                );
                for (const localId of params.expectedLocalIdsBySession.get(sessionId) ?? []) {
                    if (!localIdSet.has(localId)) {
                        throw new Error(`Mixed workload transcript verification missed localId ${localId} for ${sessionId}`);
                    }
                }
            } catch (error) {
                setTrafficFailureIfAbsent({
                    stage: 'verification',
                    sessionId,
                    authIndex: session.authIndex,
                    rpcCallsCompleted: rpcCalls,
                    messagesSentBeforeFailure: ackLatencies.length,
                    reconnectsTriggered,
                    rpcReadinessProbed: rpcReadinessLedger.length,
                    rpcReadinessFailed: rpcReadinessLedger.filter((entry) => entry.status === 'error').length,
                    error: error instanceof Error ? error.message : String(error),
                });
                throw error;
            }
        }
        stageDurationsMs.verificationMs = Date.now() - verificationStartedAt;
    } catch (error) {
        if (error instanceof Error && /connect|disconnect|timed out|Missing reconnect collector/iu.test(error.message)) {
            reconnectFailures += 1;
        }
        const failure = new Error(error instanceof Error ? error.message : String(error));
        Object.assign(failure, {
            partialResult: {
                listeners,
                rpcReadinessLedger,
                ...(failedRpc ? { failedRpc } : {}),
                ...(trafficFailure ? { trafficFailure } : {}),
                ackLatencies,
                rpcLatencies,
                streamDispatchLatencies,
                duplicateLocalIds,
                messageAckFailures,
                rpcFailures,
                reconnectFailures,
                reconnectsTriggered,
                rpcCalls,
                streamSegmentsSent,
                stageDurationsMs,
            } satisfies MixedRealisticTrafficResult,
        });
        throw failure;
    }

    return {
        listeners,
        rpcReadinessLedger,
        ...(failedRpc ? { failedRpc } : {}),
        ...(trafficFailure ? { trafficFailure } : {}),
        ackLatencies,
        rpcLatencies,
        streamDispatchLatencies,
        duplicateLocalIds,
        messageAckFailures,
        rpcFailures,
        reconnectFailures,
        reconnectsTriggered,
        rpcCalls,
        streamSegmentsSent,
        stageDurationsMs,
    };
}
