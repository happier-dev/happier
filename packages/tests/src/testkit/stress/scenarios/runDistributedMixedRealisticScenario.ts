import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { repoRootDir } from '../../paths';
import type { RunDirs } from '../../runDir';
import { runLoggedCommand } from '../../process/spawnProcess';
import type { StressConfig } from '../config/stressScenarioSchema';
import { finalizeStressScenario } from '../reporting/finalizeStressScenario';
import { buildMixedConnectCeilingShardPlans, type MixedConnectCeilingShardPlan } from './mixedConnectCeilingSharding';
import {
    recoverFullComposeFailureDiagnosticsMetrics,
    resolveComposeNetworkControlPlaneBaseUrls,
    startContainerMemoryPeakSampler,
    startClusterServiceMetricPeakSampler,
} from './fullComposeScenarioSupport';
import {
    MIXED_REALISTIC_API_CACHE_ENTRY_SELECTORS,
    MIXED_REALISTIC_API_HEAP_SPACE_PEAK_SELECTORS,
    type MixedRealisticApiDiagnosticSignalSummary,
    MIXED_REALISTIC_API_PEAK_METRIC_NAMES,
    MIXED_REALISTIC_API_PROVISIONING_HTTP_SELECTORS,
    resolveMixedRealisticApiThresholdSignals,
    scrapeMixedRealisticFullComposeMetrics,
} from './runMixedRealisticScenario';
import { summarizeLatencySamples } from './stressScenarioRuntime';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { createEmptyMixedProvisioningStages, type MixedProvisioningStageName, type MixedProvisioningStages } from './mixedScenarioBootstrap';
import type {
    MixedRealisticShardProgressSnapshot,
    MixedRealisticShardResult,
} from './runMixedRealisticShardWork';

type MixedRealisticShardRequest = Readonly<{
    baseUrl: string;
    controlPlaneBaseUrl?: string;
    controlPlaneBaseUrls?: readonly string[];
    config: StressConfig;
    shardPlan: MixedConnectCeilingShardPlan;
    outputPath: string;
    progressPath?: string;
}>;

type DistributedMixedRealisticScenarioDeps = Readonly<{
    repoRootDir: typeof repoRootDir;
    runLoggedCommand: typeof runLoggedCommand;
    scrapeMixedRealisticFullComposeMetrics: typeof scrapeMixedRealisticFullComposeMetrics;
    finalizeStressScenario: typeof finalizeStressScenario;
}>;

const defaultDeps: DistributedMixedRealisticScenarioDeps = {
    repoRootDir,
    runLoggedCommand,
    scrapeMixedRealisticFullComposeMetrics,
    finalizeStressScenario,
};

function resolveComposeNetworkBaseUrl(target: StartedStressTarget, config: StressConfig): string {
    if (target.mode !== 'full-compose') {
        return target.baseUrl;
    }
    return config.compose.frontDoorMode === 'api-direct'
        ? 'http://api-direct:53288'
        : 'http://gateway:8080';
}

function resolveComposeSharedLoadgenDir(target: StartedStressTarget): { hostPath: string; containerPath: string } {
    const composeFile = target.artifacts?.composeFile;
    if (!composeFile) {
        throw new Error('Missing compose file artifact for compose-network load generation');
    }
    const hostPath = join(dirname(composeFile), 'loadgen');
    return {
        hostPath,
        containerPath: '/stress-shared/loadgen',
    };
}

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildComposeNetworkShardShellCommand(params: {
    requestPath: string;
    stdoutPath: string;
    stderrPath: string;
}): string {
    return [
        'mkdir -p /stress-shared/loadgen-node-diagnostics',
        '&&',
        'node',
        'scripts/runTsxEntrypoint.mjs',
        'src/testkit/stress/cli/runMixedRealisticShard.ts',
        params.requestPath,
        `>${params.stdoutPath}`,
        `2>${params.stderrPath}`,
    ].join(' ');
}

function readShardResult(outputPath: string): MixedRealisticShardResult | undefined {
    try {
        return JSON.parse(readFileSync(outputPath, 'utf8')) as MixedRealisticShardResult;
    } catch {
        return undefined;
    }
}

function readShardProgressSnapshots(progressPath: string): MixedRealisticShardProgressSnapshot[] {
    try {
        return JSON.parse(readFileSync(progressPath, 'utf8')) as MixedRealisticShardProgressSnapshot[];
    } catch {
        return [];
    }
}

function shouldWriteFallbackShardErrorLog(stderrPath: string): boolean {
    if (!existsSync(stderrPath)) {
        return true;
    }
    try {
        return statSync(stderrPath).size === 0;
    } catch {
        return true;
    }
}

function pushShardResultIfPresent(params: {
    shardResults: MixedRealisticShardResult[];
    outputPath: string;
}): MixedRealisticShardResult | undefined {
    const shardResult = readShardResult(params.outputPath);
    if (!shardResult) {
        return undefined;
    }
    if (!params.shardResults.some((existing) => existing.shardIndex === shardResult.shardIndex)) {
        params.shardResults.push(shardResult);
    }
    return shardResult;
}

function pushShardProgressSnapshotsIfPresent(params: {
    shardProgressSnapshotsByShard: Map<number, readonly MixedRealisticShardProgressSnapshot[]>;
    shardIndex: number;
    progressPath: string;
}): readonly MixedRealisticShardProgressSnapshot[] {
    const progressSnapshots = readShardProgressSnapshots(params.progressPath);
    if (progressSnapshots.length === 0) {
        return [];
    }
    params.shardProgressSnapshotsByShard.set(params.shardIndex, progressSnapshots);
    return progressSnapshots;
}

function aggregateProvisioningStages(shardResults: readonly MixedRealisticShardResult[]): MixedProvisioningStages {
    const aggregated = createEmptyMixedProvisioningStages() as Record<MixedProvisioningStageName, {
        completedCount: number;
        failedCount: number;
        totalMs: number;
    }>;
    for (const result of shardResults) {
        for (const stageName of Object.keys(aggregated) as MixedProvisioningStageName[]) {
            const current = aggregated[stageName];
            const shardSummary = result.provisioningStages[stageName];
            aggregated[stageName] = {
                completedCount: current.completedCount + shardSummary.completedCount,
                failedCount: current.failedCount + shardSummary.failedCount,
                totalMs: current.totalMs + shardSummary.totalMs,
            };
        }
    }
    return aggregated;
}

function aggregateConnectivitySnapshot(shardResults: readonly MixedRealisticShardResult[]) {
    const disconnectedUserSample = shardResults
        .flatMap((result) => result.connectivitySnapshot?.userDevices.disconnectedSample ?? [])
        .slice(0, 16);
    const disconnectedCollectorSample = shardResults
        .flatMap((result) => result.connectivitySnapshot?.machineCollectors.disconnectedSample ?? [])
        .slice(0, 16);
    const mergeCountRecords = (records: readonly Record<string, number>[]): Record<string, number> => {
        const merged: Record<string, number> = {};
        for (const record of records) {
            for (const [key, value] of Object.entries(record)) {
                merged[key] = (merged[key] ?? 0) + value;
            }
        }
        return merged;
    };

    return {
        userDevices: {
            total: shardResults.reduce((sum, result) => sum + (result.connectivitySnapshot?.userDevices.total ?? 0), 0),
            connected: shardResults.reduce((sum, result) => sum + (result.connectivitySnapshot?.userDevices.connected ?? 0), 0),
            disconnectedAuthIndexes: shardResults.flatMap((result) => result.connectivitySnapshot?.userDevices.disconnectedAuthIndexes ?? []),
            eventSummary: {
                lastConnectErrorMessageCounts: mergeCountRecords(
                    shardResults.map((result) => result.connectivitySnapshot?.userDevices.eventSummary?.lastConnectErrorMessageCounts ?? {}),
                ),
                lastDisconnectReasonCounts: mergeCountRecords(
                    shardResults.map((result) => result.connectivitySnapshot?.userDevices.eventSummary?.lastDisconnectReasonCounts ?? {}),
                ),
                missingLastConnectErrorCount: shardResults.reduce(
                    (sum, result) => sum + (result.connectivitySnapshot?.userDevices.eventSummary?.missingLastConnectErrorCount ?? 0),
                    0,
                ),
                missingLastDisconnectCount: shardResults.reduce(
                    (sum, result) => sum + (result.connectivitySnapshot?.userDevices.eventSummary?.missingLastDisconnectCount ?? 0),
                    0,
                ),
            },
            disconnectedSample: disconnectedUserSample,
        },
        machineCollectors: {
            total: shardResults.reduce((sum, result) => sum + (result.connectivitySnapshot?.machineCollectors.total ?? 0), 0),
            connected: shardResults.reduce((sum, result) => sum + (result.connectivitySnapshot?.machineCollectors.connected ?? 0), 0),
            disconnectedCount: shardResults.reduce((sum, result) => sum + (result.connectivitySnapshot?.machineCollectors.disconnectedCount ?? 0), 0),
            disconnectedAuthIndexes: shardResults.flatMap((result) => result.connectivitySnapshot?.machineCollectors.disconnectedAuthIndexes ?? []),
            eventSummary: {
                lastConnectErrorMessageCounts: mergeCountRecords(
                    shardResults.map((result) => result.connectivitySnapshot?.machineCollectors.eventSummary?.lastConnectErrorMessageCounts ?? {}),
                ),
                lastDisconnectReasonCounts: mergeCountRecords(
                    shardResults.map((result) => result.connectivitySnapshot?.machineCollectors.eventSummary?.lastDisconnectReasonCounts ?? {}),
                ),
                missingLastConnectErrorCount: shardResults.reduce(
                    (sum, result) => sum + (result.connectivitySnapshot?.machineCollectors.eventSummary?.missingLastConnectErrorCount ?? 0),
                    0,
                ),
                missingLastDisconnectCount: shardResults.reduce(
                    (sum, result) => sum + (result.connectivitySnapshot?.machineCollectors.eventSummary?.missingLastDisconnectCount ?? 0),
                    0,
                ),
            },
            disconnectedSample: disconnectedCollectorSample,
        },
    };
}

function summarizeAuthIndexModuloCounts(
    authIndexes: readonly number[],
    moduloBase: number,
): { moduloBase: number; counts: Record<string, number> } | undefined {
    if (authIndexes.length === 0) {
        return undefined;
    }
    const normalizedModuloBase = Math.max(1, Math.abs(Math.trunc(moduloBase)));
    const counts: Record<string, number> = {};
    for (const authIndex of authIndexes) {
        const normalizedIndex = Number.isFinite(authIndex) ? Math.trunc(authIndex) : 0;
        const remainder = ((normalizedIndex % normalizedModuloBase) + normalizedModuloBase) % normalizedModuloBase;
        counts[String(remainder)] = (counts[String(remainder)] ?? 0) + 1;
    }
    return {
        moduloBase: normalizedModuloBase,
        counts,
    };
}

function summarizeShardProgressSnapshots(params: {
    shardPlans: readonly MixedConnectCeilingShardPlan[];
    shardProgressSnapshots: readonly MixedRealisticShardProgressSnapshot[];
}) {
    const latestByShard = new Map<number, MixedRealisticShardProgressSnapshot>();
    for (const snapshot of params.shardProgressSnapshots) {
        latestByShard.set(snapshot.shardIndex, snapshot);
    }
    const latestPhaseCounts: Record<string, number> = {};
    for (const snapshot of latestByShard.values()) {
        const key = snapshot.subphase
            ? `${snapshot.phase}:${snapshot.subphase}:${snapshot.status}`
            : `${snapshot.phase}:${snapshot.status}`;
        latestPhaseCounts[key] = (latestPhaseCounts[key] ?? 0) + 1;
    }
    return {
        totalSnapshots: params.shardProgressSnapshots.length,
        shardsWithSnapshots: latestByShard.size,
        shardCount: params.shardPlans.length,
        latestPhaseCounts,
        latestByShard: params.shardPlans
            .map((shardPlan) => latestByShard.get(shardPlan.shardIndex))
            .filter((snapshot): snapshot is MixedRealisticShardProgressSnapshot => !!snapshot),
    };
}

function summarizeShardOutcomes(params: {
    shardPlans: readonly MixedConnectCeilingShardPlan[];
    shardResults: readonly MixedRealisticShardResult[];
    progressSnapshots: readonly MixedRealisticShardProgressSnapshot[];
    latestProgressSnapshots: readonly MixedRealisticShardProgressSnapshot[];
    authIndexModuloBase: number;
}) {
    const shardResultsByIndex = new Map(params.shardResults.map((result) => [result.shardIndex, result] as const));
    const latestProgressByShard = new Map(
        params.latestProgressSnapshots.map((snapshot) => [snapshot.shardIndex, snapshot] as const),
    );
    const progressSnapshotsByShard = new Map<number, MixedRealisticShardProgressSnapshot[]>();
    for (const snapshot of params.progressSnapshots) {
        const snapshots = progressSnapshotsByShard.get(snapshot.shardIndex) ?? [];
        snapshots.push(snapshot);
        progressSnapshotsByShard.set(snapshot.shardIndex, snapshots);
    }
    return params.shardPlans.map((shardPlan) => {
        const shardResult = shardResultsByIndex.get(shardPlan.shardIndex);
        const latestProgress = latestProgressByShard.get(shardPlan.shardIndex);
        const progressSnapshots = progressSnapshotsByShard.get(shardPlan.shardIndex) ?? [];
        const peakProgressSnapshot = progressSnapshots.reduce<MixedRealisticShardProgressSnapshot | undefined>((peak, snapshot) => {
            if (!peak || snapshot.memoryUsage.rssBytes > peak.memoryUsage.rssBytes) {
                return snapshot;
            }
            return peak;
        }, undefined);
        const machineCollectorDisconnectedAuthIndexes = shardResult?.connectivitySnapshot?.machineCollectors.disconnectedAuthIndexes ?? [];
        return {
            shardIndex: shardPlan.shardIndex,
            authIndexStart: shardPlan.authIndexStart,
            authIndexEndExclusive: shardPlan.authIndexEndExclusive,
            ...(shardResult
                ? {
                    counts: shardResult.counts,
                    failures: shardResult.failures,
                    rpcReadiness: shardResult.rpcReadiness,
                    ...(shardResult.connectivitySnapshot ? { connectivitySnapshot: shardResult.connectivitySnapshot } : {}),
                    ...(shardResult.failedRpc ? { failedRpc: shardResult.failedRpc } : {}),
                    ...(shardResult.trafficFailure ? { trafficFailure: shardResult.trafficFailure } : {}),
                    ...(machineCollectorDisconnectedAuthIndexes.length > 0
                        ? {
                            machineCollectorDisconnectedAuthIndexes,
                            machineCollectorDisconnectedAuthIndexModuloCounts: summarizeAuthIndexModuloCounts(
                                machineCollectorDisconnectedAuthIndexes,
                                params.authIndexModuloBase,
                            ),
                        }
                        : {}),
                }
                : {}),
            ...(shardResult?.connectivitySnapshot
                ? {
                    connectivityDeficit: {
                        userDevicesDisconnected: Math.max(
                            0,
                            shardResult.connectivitySnapshot.userDevices.total
                                - shardResult.connectivitySnapshot.userDevices.connected,
                        ),
                        machineCollectorsDisconnected: Math.max(
                            0,
                            shardResult.connectivitySnapshot.machineCollectors.total
                                - shardResult.connectivitySnapshot.machineCollectors.connected,
                        ),
                    },
                }
                : {}),
            ...(peakProgressSnapshot
                ? {
                    progressResourceEnvelope: {
                        sampleCount: progressSnapshots.length,
                        peakRssBytes: peakProgressSnapshot.memoryUsage.rssBytes,
                        peakHeapUsedBytes: peakProgressSnapshot.memoryUsage.heapUsedBytes,
                        peakHeapTotalBytes: peakProgressSnapshot.memoryUsage.heapTotalBytes,
                        peakExternalBytes: peakProgressSnapshot.memoryUsage.externalBytes,
                        peakArrayBuffersBytes: peakProgressSnapshot.memoryUsage.arrayBuffersBytes,
                        peakAt: {
                            phase: peakProgressSnapshot.phase,
                            ...(peakProgressSnapshot.subphase ? { subphase: peakProgressSnapshot.subphase } : {}),
                            status: peakProgressSnapshot.status,
                        },
                    },
                }
                : {}),
            ...(latestProgress
                ? {
                    latestProgress: {
                        phase: latestProgress.phase,
                        ...(latestProgress.subphase ? { subphase: latestProgress.subphase } : {}),
                        status: latestProgress.status,
                        ...(latestProgress.error ? { error: latestProgress.error } : {}),
                        memoryUsage: latestProgress.memoryUsage,
                        counts: latestProgress.counts,
                        stageDurationsMs: latestProgress.stageDurationsMs,
                    },
                }
                : {}),
        };
    });
}

export async function runDistributedMixedRealisticScenario(
    params: {
        run: RunDirs;
        target: StartedStressTarget;
        config: StressConfig;
    },
    deps: DistributedMixedRealisticScenarioDeps = defaultDeps,
): Promise<void> {
    const testDir = params.run.testDir('mixed-realistic');
    mkdirSync(testDir, { recursive: true });
    const startedAt = new Date().toISOString();
    const shardPlans = buildMixedConnectCeilingShardPlans(params.config);
    const loadGenerationMode = params.config.compose.loadGenerationMode ?? 'host';
    const shardResults: MixedRealisticShardResult[] = [];
    const shardProgressSnapshotsByShard = new Map<number, readonly MixedRealisticShardProgressSnapshot[]>();
    const shouldCollectFullComposeMetrics = params.target.mode === 'full-compose'
        && params.config.compose.metricsEnabled
        && params.config.artifacts.metricsScrapeEnabled;
    const topologyServices = (params.target as Partial<StartedStressTarget>).topology?.services;
    const containerMemoryPeakServices = (
        Array.isArray(topologyServices)
            ? topologyServices
            : ['api', 'worker']
    ).filter((service): service is string =>
        typeof service === 'string'
        && ['api', 'worker', 'gateway', 'loadgen', 'redis', 'postgres', 'minio'].includes(service));
    const apiReplicaPeakSampler = shouldCollectFullComposeMetrics
        ? startClusterServiceMetricPeakSampler({
            target: params.target,
            service: 'api',
            metricNames: MIXED_REALISTIC_API_PEAK_METRIC_NAMES,
            selectors: [
                ...MIXED_REALISTIC_API_PROVISIONING_HTTP_SELECTORS,
                ...MIXED_REALISTIC_API_CACHE_ENTRY_SELECTORS,
                ...MIXED_REALISTIC_API_HEAP_SPACE_PEAK_SELECTORS,
            ],
            thresholdSignals: resolveMixedRealisticApiThresholdSignals(params.config),
        })
        : undefined;
    const containerMemoryPeakSampler = shouldCollectFullComposeMetrics
        ? startContainerMemoryPeakSampler({
            target: params.target,
            services: containerMemoryPeakServices,
        })
        : undefined;
    let apiReplicaPeakMetrics: Awaited<ReturnType<ReturnType<typeof startClusterServiceMetricPeakSampler>['stop']>>['replicas'] = [];
    let apiReplicaPeakMetricsError: string | undefined;
    let apiReplicaDiagnosticSignals: MixedRealisticApiDiagnosticSignalSummary | undefined;
    let containerMemoryPeakMetrics: Awaited<ReturnType<ReturnType<typeof startContainerMemoryPeakSampler>['stop']>>['containers'] = [];
    let containerMemoryPeakMetricsError: string | undefined;
    let metrics: Record<string, unknown> = {};
    let failure: unknown;

    try {
        const composeNetworkControlPlaneBaseUrls = loadGenerationMode === 'compose-network'
            ? await resolveComposeNetworkControlPlaneBaseUrls(params.target, params.config)
            : undefined;
        const composeNetworkLoadgenContainers = loadGenerationMode === 'compose-network'
            ? (await params.target.admin?.listServiceContainers('loadgen') ?? [])
                .filter((container) => container.state === 'running')
            : [];
        const settledShardResults = await Promise.allSettled(
            shardPlans.map(async (shardPlan) => {
                const shardPrefix = `shard-${shardPlan.shardIndex}`;
                const composeSharedDir = loadGenerationMode === 'compose-network'
                    ? resolveComposeSharedLoadgenDir(params.target)
                    : undefined;
                const hostArtifactDir = composeSharedDir?.hostPath ?? testDir;
                mkdirSync(hostArtifactDir, { recursive: true });
                const requestPath = join(hostArtifactDir, `${shardPrefix}.request.json`);
                const outputPath = join(hostArtifactDir, `${shardPrefix}.result.json`);
                const progressPath = join(hostArtifactDir, `${shardPrefix}.progress.json`);
                const stdoutPath = join(hostArtifactDir, `${shardPrefix}.stdout.log`);
                const stderrPath = join(hostArtifactDir, `${shardPrefix}.stderr.log`);
                const testsWorkspaceDir = join(deps.repoRootDir(), 'packages/tests');
                const containerRequestPath = composeSharedDir
                    ? join(composeSharedDir.containerPath, `${shardPrefix}.request.json`)
                    : undefined;
                const containerOutputPath = composeSharedDir
                    ? join(composeSharedDir.containerPath, `${shardPrefix}.result.json`)
                    : undefined;
                const containerProgressPath = composeSharedDir
                    ? join(composeSharedDir.containerPath, `${shardPrefix}.progress.json`)
                    : undefined;
                const containerStdoutPath = composeSharedDir
                    ? join(composeSharedDir.containerPath, `${shardPrefix}.stdout.log`)
                    : undefined;
                const containerStderrPath = composeSharedDir
                    ? join(composeSharedDir.containerPath, `${shardPrefix}.stderr.log`)
                    : undefined;
                const request: MixedRealisticShardRequest = {
                    baseUrl: loadGenerationMode === 'compose-network'
                        ? resolveComposeNetworkBaseUrl(params.target, params.config)
                        : params.target.baseUrl,
                    controlPlaneBaseUrl: loadGenerationMode === 'compose-network'
                        ? composeNetworkControlPlaneBaseUrls?.[0] ?? 'http://api:53288'
                        : params.target.baseUrl,
                    controlPlaneBaseUrls: composeNetworkControlPlaneBaseUrls,
                    config: {
                        ...params.config,
                        load: {
                            ...params.config.load,
                            users: shardPlan.userCount,
                            mixedSetupConcurrency: shardPlan.mixedSetupConcurrency,
                            mixedConnectConcurrency: shardPlan.mixedConnectConcurrency,
                            mixedRunnerShards: 1,
                        },
                    },
                    shardPlan,
                    outputPath: loadGenerationMode === 'compose-network'
                        ? (containerOutputPath ?? outputPath)
                        : outputPath,
                    progressPath: loadGenerationMode === 'compose-network'
                        ? (containerProgressPath ?? progressPath)
                        : progressPath,
                };
                writeJson(requestPath, request);

                try {
                    if (loadGenerationMode === 'compose-network') {
                        if (!containerRequestPath || !containerStdoutPath || !containerStderrPath) {
                            throw new Error('Missing compose-network request path');
                        }
                        if (!params.target.admin?.execInService) {
                            throw new Error('Compose-network load generation requires target admin.execInService');
                        }
                        const shellCommand = buildComposeNetworkShardShellCommand({
                            requestPath: containerRequestPath,
                            stdoutPath: containerStdoutPath,
                            stderrPath: containerStderrPath,
                        });
                        const output = (
                            composeNetworkLoadgenContainers.length > 0 && params.target.admin.execInContainer
                                ? await params.target.admin.execInContainer(
                                    composeNetworkLoadgenContainers[shardPlan.shardIndex % composeNetworkLoadgenContainers.length]!.id,
                                    ['sh', '-lc', shellCommand],
                                )
                                : await params.target.admin.execInService('loadgen', ['sh', '-lc', shellCommand])
                        );
                        if (output.length > 0) {
                            writeFileSync(stdoutPath, output, 'utf8');
                        }
                    } else {
                        await deps.runLoggedCommand({
                            command: process.execPath,
                            args: [
                                'scripts/runTsxEntrypoint.mjs',
                                'src/testkit/stress/cli/runMixedRealisticShard.ts',
                                requestPath,
                            ],
                            cwd: testsWorkspaceDir,
                            stdoutPath,
                            stderrPath,
                            env: {
                                ...process.env,
                                FORCE_COLOR: '0',
                            },
                        });
                    }
                } catch (error) {
                    if (shouldWriteFallbackShardErrorLog(stderrPath)) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        writeFileSync(stderrPath, `${errorMessage}\n`, 'utf8');
                    }
                    pushShardResultIfPresent({
                        shardResults,
                        outputPath,
                    });
                    pushShardProgressSnapshotsIfPresent({
                        shardProgressSnapshotsByShard,
                        shardIndex: shardPlan.shardIndex,
                        progressPath,
                    });
                    throw error;
                }

                const shardResult = pushShardResultIfPresent({
                    shardResults,
                    outputPath,
                });
                pushShardProgressSnapshotsIfPresent({
                    shardProgressSnapshotsByShard,
                    shardIndex: shardPlan.shardIndex,
                    progressPath,
                });
                if (!shardResult) {
                    throw new Error(`Mixed realistic shard ${shardPlan.shardIndex} did not write a result file`);
                }
                return shardResult;
            }),
        );

        const shardErrors = settledShardResults
            .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
            .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
        if (shardErrors.length > 0) {
            throw new Error(shardErrors.join('; '));
        }

        if (apiReplicaPeakSampler) {
            const peakSamplerResult = await apiReplicaPeakSampler.stop();
            apiReplicaPeakMetrics = peakSamplerResult.replicas;
            apiReplicaPeakMetricsError = peakSamplerResult.error;
            apiReplicaDiagnosticSignals = (
                (peakSamplerResult.signalEvents?.length ?? 0) > 0
                || (peakSamplerResult.signalErrors?.length ?? 0) > 0
            )
                ? {
                    triggered: peakSamplerResult.signalEvents ?? [],
                    ...((peakSamplerResult.signalErrors?.length ?? 0) > 0
                        ? { errors: peakSamplerResult.signalErrors }
                        : {}),
                }
                : undefined;
        }
        if (containerMemoryPeakSampler) {
            const memoryPeakSamplerResult = await containerMemoryPeakSampler.stop();
            containerMemoryPeakMetrics = memoryPeakSamplerResult.containers;
            containerMemoryPeakMetricsError = memoryPeakSamplerResult.error;
        }

        if (shouldCollectFullComposeMetrics) {
            metrics = await deps.scrapeMixedRealisticFullComposeMetrics({
                target: params.target,
                apiReplicaPeakMetrics,
                apiReplicaPeakMetricsError,
                apiReplicaDiagnosticSignals,
                containerMemoryPeakMetrics,
                containerMemoryPeakMetricsError,
            });
        }
    } catch (error) {
        failure = error;
        if (apiReplicaPeakSampler && apiReplicaPeakMetrics.length === 0 && !apiReplicaPeakMetricsError) {
            const peakSamplerResult = await apiReplicaPeakSampler.stop();
            apiReplicaPeakMetrics = peakSamplerResult.replicas;
            apiReplicaPeakMetricsError = peakSamplerResult.error;
            apiReplicaDiagnosticSignals = (
                (peakSamplerResult.signalEvents?.length ?? 0) > 0
                || (peakSamplerResult.signalErrors?.length ?? 0) > 0
            )
                ? {
                    triggered: peakSamplerResult.signalEvents ?? [],
                    ...((peakSamplerResult.signalErrors?.length ?? 0) > 0
                        ? { errors: peakSamplerResult.signalErrors }
                        : {}),
                }
                : undefined;
        }
        if (containerMemoryPeakSampler && containerMemoryPeakMetrics.length === 0 && !containerMemoryPeakMetricsError) {
            const memoryPeakSamplerResult = await containerMemoryPeakSampler.stop();
            containerMemoryPeakMetrics = memoryPeakSamplerResult.containers;
            containerMemoryPeakMetricsError = memoryPeakSamplerResult.error;
        }
        if (shouldCollectFullComposeMetrics) {
            try {
                metrics = await deps.scrapeMixedRealisticFullComposeMetrics({
                    target: params.target,
                    apiReplicaPeakMetrics,
                    apiReplicaPeakMetricsError,
                    apiReplicaDiagnosticSignals,
                    containerMemoryPeakMetrics,
                    containerMemoryPeakMetricsError,
                });
            } catch (metricsError) {
                metrics = {
                    ...metrics,
                    failureMetricsError: metricsError instanceof Error ? metricsError.message : String(metricsError),
                };
            }
        }
        if (params.target.mode === 'full-compose') {
            try {
                metrics = await recoverFullComposeFailureDiagnosticsMetrics({
                    target: params.target,
                    metrics,
                });
            } catch (recoveryError) {
                metrics = {
                    ...metrics,
                    composeDiagnosticsError: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
                };
            }
        }
    }

    const aggregatedProvisioningStages = aggregateProvisioningStages(shardResults);
    const aggregatedConnectivitySnapshot = aggregateConnectivitySnapshot(shardResults);
    const ackLatencies = shardResults.flatMap((result) => result.latencySamples.ackLatencies);
    const rpcLatencies = shardResults.flatMap((result) => result.latencySamples.rpcLatencies);
    const streamDispatchLatencies = shardResults.flatMap((result) => result.latencySamples.streamDispatchLatencies);
    const shardResultsByIndex = new Map(shardResults.map((result) => [result.shardIndex, result] as const));
    const aggregatedShardProgressSnapshots = shardPlans.flatMap((shardPlan) => {
        const shardResult = shardResultsByIndex.get(shardPlan.shardIndex);
        if (Array.isArray(shardResult?.progressSnapshots) && shardResult.progressSnapshots.length > 0) {
            return shardResult.progressSnapshots;
        }
        return shardProgressSnapshotsByShard.get(shardPlan.shardIndex) ?? [];
    });
    const shardProgressSummary = summarizeShardProgressSnapshots({
        shardPlans,
        shardProgressSnapshots: aggregatedShardProgressSnapshots,
    });
    const shardOutcomeSummary = summarizeShardOutcomes({
        shardPlans,
        shardResults,
        progressSnapshots: aggregatedShardProgressSnapshots,
        latestProgressSnapshots: shardProgressSummary.latestByShard,
        authIndexModuloBase: Math.max(1, params.config.compose.apiReplicas),
    });
    const connectivityDeficitPatterns = {
        ...(aggregatedConnectivitySnapshot.machineCollectors.disconnectedAuthIndexes.length > 0
            ? {
                machineCollectorDisconnectedAuthIndexModuloCounts: summarizeAuthIndexModuloCounts(
                    aggregatedConnectivitySnapshot.machineCollectors.disconnectedAuthIndexes,
                    Math.max(1, params.config.compose.apiReplicas),
                ),
            }
            : {}),
    };

    await deps.finalizeStressScenario({
        run: params.run,
        testDir,
        testName: 'mixed.realistic',
        target: params.target,
        config: params.config,
        startedAt,
        sessionIds: [],
        seed: params.config.seed,
        status: failure ? 'failed' : 'passed',
        error: failure,
        counts: {
            sessions: shardResults.reduce((sum, result) => sum + result.counts.sessions, 0),
            activeSessions: shardResults.reduce((sum, result) => sum + result.counts.activeSessions, 0),
            machineSockets: shardResults.reduce((sum, result) => sum + result.counts.machineSockets, 0),
            verifiedSessions: shardResults.reduce((sum, result) => sum + result.counts.verifiedSessions, 0),
            messagesSent: shardResults.reduce((sum, result) => sum + result.counts.messagesSent, 0),
            streamSegmentsSent: shardResults.reduce((sum, result) => sum + result.counts.streamSegmentsSent, 0),
            rpcCalls: shardResults.reduce((sum, result) => sum + result.counts.rpcCalls, 0),
            rpcListeners: shardResults.reduce((sum, result) => sum + result.counts.rpcListeners, 0),
            reconnectsTriggered: shardResults.reduce((sum, result) => sum + result.counts.reconnectsTriggered, 0),
        },
        latencies: summarizeLatencySamples(ackLatencies),
        failures: {
            duplicateLocalIds: shardResults.reduce((sum, result) => sum + result.failures.duplicateLocalIds, 0),
            messageAckFailures: shardResults.reduce((sum, result) => sum + result.failures.messageAckFailures, 0),
            rpcFailures: shardResults.reduce((sum, result) => sum + result.failures.rpcFailures, 0),
            reconnectFailures: shardResults.reduce((sum, result) => sum + result.failures.reconnectFailures, 0),
        },
        metrics: {
            ...metrics,
            rpcLatencies: summarizeLatencySamples(rpcLatencies),
            streamDispatchLatencies: summarizeLatencySamples(streamDispatchLatencies),
            provisioningStages: aggregatedProvisioningStages,
            connectivitySnapshot: aggregatedConnectivitySnapshot,
            ...(Object.keys(connectivityDeficitPatterns).length > 0 ? { connectivityDeficitPatterns } : {}),
            shardPlans,
            shardProgressSnapshots: aggregatedShardProgressSnapshots,
            shardProgressSummary,
            shardOutcomeSummary,
            shardResults,
        },
    });

    if (failure) {
        throw failure;
    }
}
