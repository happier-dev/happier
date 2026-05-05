import { createTestAuth } from '../../auth';
import {
    captureMixedConnectivitySnapshot,
    compactMixedScenarioAuth,
    resolveMixedControlPlaneBaseUrlForIndex,
    summarizeMixedScenarioAuthPayload,
    type MixedScenarioAuth,
} from './mixedScenarioShared';
import { buildMixedRealisticWorkload } from './mixedRealisticWorkload';
import {
    runMixedRealisticTraffic,
    type MixedFailedRpcContext,
    type MixedTrafficFailureContext,
    type MixedRealisticTrafficResult,
    type MixedRpcReadinessLedgerEntry,
} from './mixedRealisticTraffic';
import { runStressTasksWithConcurrencyLimit } from './runStressTasksWithConcurrencyLimit';
import {
    createEmptyMixedProvisioningStages,
    runMixedScenarioBootstrap,
    type MixedScenarioBootstrapProgressSnapshot,
    type MixedProvisioningStages,
    type MixedScenarioBootstrapResult,
} from './mixedScenarioBootstrap';

export type MixedRealisticShardPhase = 'auth' | 'bootstrap' | 'traffic';

export type MixedRealisticShardProgressSnapshot = Readonly<{
    shardIndex: number;
    phase: MixedRealisticShardPhase;
    subphase?: MixedScenarioBootstrapProgressSnapshot['stage'];
    status: MixedScenarioBootstrapProgressSnapshot['status'];
    at: string;
    memoryUsage: {
        rssBytes: number;
        heapTotalBytes: number;
        heapUsedBytes: number;
        externalBytes: number;
        arrayBuffersBytes: number;
    };
        counts: {
            authsCreated: number;
            authTokenCharsRetained: number;
            authPublicKeyCharsRetained: number;
            userDeviceGroups: number;
            userScopedSockets: number;
            openedUserScopedSockets: number;
            connectedUserScopedSockets: number;
            sessions: number;
            machineCollectors: number;
            openedMachineCollectors: number;
            connectedMachineCollectors: number;
            verificationSessions: number;
            listeners: number;
            ackLatencySamples: number;
            rpcLatencySamples: number;
        streamDispatchLatencySamples: number;
        rpcReadinessEntries: number;
    };
    stageDurationsMs: {
        authMs: number;
        provisionMs: number;
        connectMs: number;
        trafficMs: number;
        verificationMs: number;
    };
    error?: string;
}>;

export type MixedRealisticShardResult = Readonly<{
    shardIndex: number;
    authIndexStart: number;
    authIndexEndExclusive: number;
    counts: {
        sessions: number;
        activeSessions: number;
        machineSockets: number;
        verifiedSessions: number;
        messagesSent: number;
        streamSegmentsSent: number;
        rpcCalls: number;
        rpcListeners: number;
        reconnectsTriggered: number;
    };
    failures: {
        duplicateLocalIds: number;
        messageAckFailures: number;
        rpcFailures: number;
        reconnectFailures: number;
    };
    latencySamples: {
        ackLatencies: number[];
        rpcLatencies: number[];
        streamDispatchLatencies: number[];
    };
    stageDurationsMs: {
        authMs: number;
        provisionMs: number;
        connectMs: number;
        trafficMs: number;
        verificationMs: number;
    };
    provisioningStages: MixedProvisioningStages;
    connectivitySnapshot?: ReturnType<typeof captureMixedConnectivitySnapshot>;
    progressSnapshots: readonly MixedRealisticShardProgressSnapshot[];
    rpcReadiness: {
        probed: number;
        successful: number;
        failed: number;
        ledger: readonly MixedRpcReadinessLedgerEntry[];
    };
    failedRpc?: MixedFailedRpcContext;
    trafficFailure?: MixedTrafficFailureContext;
}>;

function buildShardResult(params: {
    shardIndex: number;
    authIndexStart: number;
    authCount: number;
    workload: ReturnType<typeof buildMixedRealisticWorkload>;
    authMs: number;
    bootstrap?: MixedScenarioBootstrapResult;
    traffic?: MixedRealisticTrafficResult;
    connectivitySnapshot?: ReturnType<typeof captureMixedConnectivitySnapshot>;
    progressSnapshots: readonly MixedRealisticShardProgressSnapshot[];
}): MixedRealisticShardResult {
    const bootstrap = params.bootstrap;
    const traffic = params.traffic;
    return {
        shardIndex: params.shardIndex,
        authIndexStart: params.authIndexStart,
        authIndexEndExclusive: params.authIndexStart + params.authCount,
        counts: {
            sessions: bootstrap?.sessions.length ?? 0,
            activeSessions: Math.min(bootstrap?.sessions.length ?? 0, params.workload.activeSessionCount),
            machineSockets: bootstrap?.machineCollectors.length ?? 0,
            verifiedSessions: bootstrap?.verificationSessionIds.length ?? 0,
            messagesSent: traffic?.ackLatencies.length ?? 0,
            streamSegmentsSent: traffic?.streamSegmentsSent ?? 0,
            rpcCalls: traffic?.rpcCalls ?? 0,
            rpcListeners: traffic?.listeners.length ?? 0,
            reconnectsTriggered: traffic?.reconnectsTriggered ?? 0,
        },
        failures: {
            duplicateLocalIds: traffic?.duplicateLocalIds ?? 0,
            messageAckFailures: traffic?.messageAckFailures ?? 0,
            rpcFailures: traffic?.rpcFailures ?? 0,
            reconnectFailures: traffic?.reconnectFailures ?? 0,
        },
        latencySamples: {
            ackLatencies: traffic?.ackLatencies ?? [],
            rpcLatencies: traffic?.rpcLatencies ?? [],
            streamDispatchLatencies: traffic?.streamDispatchLatencies ?? [],
        },
        stageDurationsMs: {
            authMs: params.authMs,
            provisionMs: bootstrap?.stageDurationsMs.provisionMs ?? 0,
            connectMs: (bootstrap?.stageDurationsMs.connectMs ?? 0) + (traffic?.stageDurationsMs.connectMs ?? 0),
            trafficMs: traffic?.stageDurationsMs.trafficMs ?? 0,
            verificationMs: traffic?.stageDurationsMs.verificationMs ?? 0,
        },
        provisioningStages: bootstrap?.provisioningStages ?? createEmptyMixedProvisioningStages(),
        ...(params.connectivitySnapshot ? { connectivitySnapshot: params.connectivitySnapshot } : {}),
        progressSnapshots: [...params.progressSnapshots],
        rpcReadiness: {
            probed: traffic?.rpcReadinessLedger.length ?? 0,
            successful: traffic?.rpcReadinessLedger.filter((entry) => entry.status === 'ok').length ?? 0,
            failed: traffic?.rpcReadinessLedger.filter((entry) => entry.status === 'error').length ?? 0,
            ledger: traffic?.rpcReadinessLedger ?? [],
        },
        ...(traffic?.failedRpc ? { failedRpc: traffic.failedRpc } : {}),
        ...(traffic?.trafficFailure ? { trafficFailure: traffic.trafficFailure } : {}),
    };
}

function closeBootstrapSockets(bootstrap: MixedScenarioBootstrapResult | undefined): void {
    if (!bootstrap) {
        return;
    }
    bootstrap.userDevices.forEach((userDevice) => userDevice.devices.forEach((device) => device.close()));
    bootstrap.machineCollectors.forEach((collector) => collector.socket.close());
}

function isMixedScenarioBootstrapResult(value: unknown): value is MixedScenarioBootstrapResult {
    return typeof value === 'object'
        && value !== null
        && 'userDevices' in value
        && 'sessions' in value
        && 'machineCollectors' in value;
}

function isMixedRealisticTrafficResult(value: unknown): value is MixedRealisticTrafficResult {
    return typeof value === 'object'
        && value !== null
        && 'listeners' in value
        && 'ackLatencies' in value
        && 'rpcReadinessLedger' in value;
}

function buildShardProgressSnapshot(params: {
    shardIndex: number;
    phase: MixedRealisticShardPhase;
    status: MixedScenarioBootstrapProgressSnapshot['status'];
    auths?: readonly { token: string; publicKeyBase64?: string }[];
    authsCreated: number;
    authMs: number;
    bootstrap?: MixedScenarioBootstrapResult;
    traffic?: MixedRealisticTrafficResult;
    bootstrapProgress?: MixedScenarioBootstrapProgressSnapshot;
    error?: string;
}): MixedRealisticShardProgressSnapshot {
    const bootstrap = params.bootstrap;
    const traffic = params.traffic;
    const bootstrapProgress = params.bootstrapProgress;
    const memoryUsage = process.memoryUsage();
    const authPayloadSummary = summarizeMixedScenarioAuthPayload(params.auths ?? []);
    return {
        shardIndex: params.shardIndex,
        phase: params.phase,
        ...(bootstrapProgress ? { subphase: bootstrapProgress.stage } : {}),
        status: params.status,
        at: new Date().toISOString(),
        memoryUsage: {
            rssBytes: memoryUsage.rss,
            heapTotalBytes: memoryUsage.heapTotal,
            heapUsedBytes: memoryUsage.heapUsed,
            externalBytes: memoryUsage.external,
            arrayBuffersBytes: memoryUsage.arrayBuffers,
        },
        counts: {
            authsCreated: params.authsCreated,
            authTokenCharsRetained: authPayloadSummary.tokenCharsRetained,
            authPublicKeyCharsRetained: authPayloadSummary.publicKeyCharsRetained,
            userDeviceGroups: bootstrap?.userDevices.length ?? bootstrapProgress?.counts.userDeviceGroups ?? 0,
            userScopedSockets: bootstrap?.userDevices.reduce((sum, userDevice) => sum + userDevice.devices.length, 0)
                ?? bootstrapProgress?.counts.userScopedSockets
                ?? 0,
            openedUserScopedSockets: bootstrapProgress?.counts.openedUserScopedSockets
                ?? bootstrap?.userDevices.reduce((sum, userDevice) => sum + userDevice.devices.length, 0)
                ?? 0,
            connectedUserScopedSockets: bootstrapProgress?.counts.connectedUserScopedSockets
                ?? bootstrap?.userDevices.reduce(
                    (sum, userDevice) => sum + userDevice.devices.filter((device) => device.isConnected()).length,
                    0,
                )
                ?? 0,
            sessions: bootstrap?.sessions.length ?? bootstrapProgress?.counts.sessions ?? 0,
            machineCollectors: bootstrap?.machineCollectors.length ?? bootstrapProgress?.counts.machineCollectors ?? 0,
            openedMachineCollectors: bootstrapProgress?.counts.openedMachineCollectors
                ?? bootstrap?.machineCollectors.length
                ?? 0,
            connectedMachineCollectors: bootstrapProgress?.counts.connectedMachineCollectors
                ?? bootstrap?.machineCollectors.reduce(
                    (sum, collector) => sum + (collector.socket.isConnected() ? 1 : 0),
                    0,
                )
                ?? 0,
            verificationSessions: bootstrap?.verificationSessionIds.length ?? bootstrapProgress?.counts.verificationSessions ?? 0,
            listeners: traffic?.listeners.length ?? 0,
            ackLatencySamples: traffic?.ackLatencies.length ?? 0,
            rpcLatencySamples: traffic?.rpcLatencies.length ?? 0,
            streamDispatchLatencySamples: traffic?.streamDispatchLatencies.length ?? 0,
            rpcReadinessEntries: traffic?.rpcReadinessLedger.length ?? 0,
        },
        stageDurationsMs: {
            authMs: params.authMs,
            provisionMs: bootstrap?.stageDurationsMs.provisionMs ?? bootstrapProgress?.stageDurationsMs.provisionMs ?? 0,
            connectMs: (bootstrap?.stageDurationsMs.connectMs ?? bootstrapProgress?.stageDurationsMs.connectMs ?? 0)
                + (traffic?.stageDurationsMs.connectMs ?? 0),
            trafficMs: traffic?.stageDurationsMs.trafficMs ?? 0,
            verificationMs: traffic?.stageDurationsMs.verificationMs ?? 0,
        },
        ...(params.error ? { error: params.error } : {}),
    };
}

async function recordShardProgressSnapshot(params: {
    progressSnapshots: MixedRealisticShardProgressSnapshot[];
    snapshot: MixedRealisticShardProgressSnapshot;
    onProgressSnapshot?: (snapshot: MixedRealisticShardProgressSnapshot) => Promise<void> | void;
}): Promise<void> {
    params.progressSnapshots.push(params.snapshot);
    await params.onProgressSnapshot?.(params.snapshot);
}

export async function runMixedRealisticShardWork(params: {
    baseUrl: string;
    controlPlaneBaseUrl?: string;
    controlPlaneBaseUrls?: readonly string[];
    config: Parameters<typeof buildMixedRealisticWorkload>[0];
    authIndexStart: number;
    shardIndex: number;
    onProgressSnapshot?: (snapshot: MixedRealisticShardProgressSnapshot) => Promise<void> | void;
}): Promise<MixedRealisticShardResult> {
    const authSlots = Array.from({ length: Math.max(1, params.config.load.users) }, (_, index) => index);
    const authConcurrency = Math.max(1, params.config.load.mixedSetupConcurrency ?? authSlots.length);
    const workload = buildMixedRealisticWorkload(params.config);
    const progressSnapshots: MixedRealisticShardProgressSnapshot[] = [];
    const authCreationStartedAt = Date.now();
    let authMs = 0;
    let authsCreated = 0;
    let auths: readonly MixedScenarioAuth[] = [];
    let bootstrap: MixedScenarioBootstrapResult | undefined;
    let traffic: MixedRealisticTrafficResult | undefined;
    let connectivitySnapshot: ReturnType<typeof captureMixedConnectivitySnapshot> | undefined;
    let trafficStarted = false;
    let latestBootstrapProgress: MixedScenarioBootstrapProgressSnapshot | undefined;

    try {
        auths = await runStressTasksWithConcurrencyLimit(authSlots, authConcurrency, async (authIndex) => {
            const auth = await createTestAuth(resolveMixedControlPlaneBaseUrlForIndex({
                baseUrl: params.baseUrl,
                controlPlaneBaseUrl: params.controlPlaneBaseUrl,
                controlPlaneBaseUrls: params.controlPlaneBaseUrls,
                index: params.authIndexStart + authIndex,
            }));
            authsCreated += 1;
            return compactMixedScenarioAuth(auth);
        });
        authMs = Date.now() - authCreationStartedAt;
        await recordShardProgressSnapshot({
            progressSnapshots,
            snapshot: buildShardProgressSnapshot({
                shardIndex: params.shardIndex,
                phase: 'auth',
                status: 'completed',
                auths,
                authsCreated,
                authMs,
            }),
            onProgressSnapshot: params.onProgressSnapshot,
        });
    } catch (error) {
        authMs = Date.now() - authCreationStartedAt;
        const failureMessage = error instanceof Error ? error.message : String(error);
        await recordShardProgressSnapshot({
            progressSnapshots,
            snapshot: buildShardProgressSnapshot({
                shardIndex: params.shardIndex,
                phase: 'auth',
                status: 'failed',
                auths,
                authsCreated,
                authMs,
                error: failureMessage,
            }),
            onProgressSnapshot: params.onProgressSnapshot,
        });
        const failure = new Error(
            `Mixed realistic shard failed for authIndexStart=${params.authIndexStart}: ${failureMessage}`,
        );
        Object.assign(failure, {
            partialResult: buildShardResult({
                shardIndex: params.shardIndex,
                authIndexStart: params.authIndexStart,
                authCount: authsCreated,
                workload,
                authMs,
                progressSnapshots,
            }),
        });
        throw failure;
    }

    try {
        await recordShardProgressSnapshot({
            progressSnapshots,
            snapshot: buildShardProgressSnapshot({
                shardIndex: params.shardIndex,
                phase: 'bootstrap',
                status: 'started',
                auths,
                authsCreated,
                authMs,
            }),
            onProgressSnapshot: params.onProgressSnapshot,
        });
        bootstrap = await runMixedScenarioBootstrap({
            baseUrl: params.baseUrl,
            controlPlaneBaseUrl: params.controlPlaneBaseUrl,
            controlPlaneBaseUrls: params.controlPlaneBaseUrls,
            config: params.config,
            auths,
            authIndexOffset: params.authIndexStart,
            workload,
            onProgressSnapshot: async (bootstrapProgress) => {
                latestBootstrapProgress = bootstrapProgress;
                await recordShardProgressSnapshot({
                    progressSnapshots,
                    snapshot: buildShardProgressSnapshot({
                        shardIndex: params.shardIndex,
                        phase: 'bootstrap',
                        status: bootstrapProgress.status,
                        auths,
                        authsCreated,
                        authMs,
                        bootstrapProgress,
                    }),
                    onProgressSnapshot: params.onProgressSnapshot,
                });
            },
        });
        await recordShardProgressSnapshot({
            progressSnapshots,
            snapshot: buildShardProgressSnapshot({
                shardIndex: params.shardIndex,
                phase: 'bootstrap',
                status: 'completed',
                auths,
                authsCreated,
                authMs,
                bootstrap,
            }),
            onProgressSnapshot: params.onProgressSnapshot,
        });
        trafficStarted = true;
        await recordShardProgressSnapshot({
            progressSnapshots,
            snapshot: buildShardProgressSnapshot({
                shardIndex: params.shardIndex,
                phase: 'traffic',
                status: 'started',
                auths,
                authsCreated,
                authMs,
                bootstrap,
            }),
            onProgressSnapshot: params.onProgressSnapshot,
        });
        traffic = await runMixedRealisticTraffic({
            baseUrl: params.baseUrl,
            controlPlaneBaseUrl: params.controlPlaneBaseUrl,
            controlPlaneBaseUrls: params.controlPlaneBaseUrls,
            config: params.config,
            workload,
            authIndexOffset: params.authIndexStart,
            userDevices: bootstrap.userDevices,
            sessions: bootstrap.sessions,
            machineCollectors: bootstrap.machineCollectors,
            verificationSessionIds: bootstrap.verificationSessionIds,
            verificationSessionTokensBySessionId: bootstrap.verificationSessionTokensBySessionId,
            expectedLocalIdsBySession: bootstrap.expectedLocalIdsBySession,
        });
        await recordShardProgressSnapshot({
            progressSnapshots,
            snapshot: buildShardProgressSnapshot({
                shardIndex: params.shardIndex,
                phase: 'traffic',
                status: 'completed',
                auths,
                authsCreated,
                authMs,
                bootstrap,
                traffic,
            }),
            onProgressSnapshot: params.onProgressSnapshot,
        });
        connectivitySnapshot = bootstrap.connectivitySnapshot ?? captureMixedConnectivitySnapshot({
            userDevices: bootstrap.userDevices,
            machineCollectors: bootstrap.machineCollectors,
        });
        return buildShardResult({
            shardIndex: params.shardIndex,
            authIndexStart: params.authIndexStart,
            authCount: auths.length,
            workload,
            authMs,
            bootstrap,
            traffic,
            connectivitySnapshot,
            progressSnapshots,
        });
    } catch (error) {
        const partialResult = error instanceof Error && 'partialResult' in error
            ? (error as Error & { partialResult?: unknown }).partialResult
            : undefined;
        if (!bootstrap && isMixedScenarioBootstrapResult(partialResult)) {
            bootstrap = partialResult;
        }
        if (!traffic && isMixedRealisticTrafficResult(partialResult)) {
            traffic = partialResult;
        }
        if (bootstrap) {
            connectivitySnapshot = bootstrap.connectivitySnapshot ?? captureMixedConnectivitySnapshot({
                userDevices: bootstrap.userDevices,
                machineCollectors: bootstrap.machineCollectors,
            });
        }
        const failureMessage = error instanceof Error ? error.message : String(error);
        await recordShardProgressSnapshot({
            progressSnapshots,
            snapshot: buildShardProgressSnapshot({
                shardIndex: params.shardIndex,
                phase: trafficStarted ? 'traffic' : 'bootstrap',
                status: 'failed',
                auths,
                authsCreated,
                authMs,
                bootstrap,
                traffic,
                bootstrapProgress: !trafficStarted ? latestBootstrapProgress : undefined,
                error: failureMessage,
            }),
            onProgressSnapshot: params.onProgressSnapshot,
        });
        const failure = new Error(
            `Mixed realistic shard failed for authIndexStart=${params.authIndexStart}: ${failureMessage}`,
        );
        Object.assign(failure, {
            partialResult: buildShardResult({
                shardIndex: params.shardIndex,
                authIndexStart: params.authIndexStart,
                authCount: authsCreated,
                workload,
                authMs,
                bootstrap,
                traffic,
                connectivitySnapshot,
                progressSnapshots,
            }),
        });
        throw failure;
    } finally {
        closeBootstrapSockets(bootstrap);
    }
}
