import { mkdtempSync, type readFileSync as readFileSyncType, type writeFileSync as writeFileSyncType } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { StressConfig } from '../config/stressScenarioSchema';
import { runMixedRealisticShardCli } from './runMixedRealisticShard';

const baseConfig: StressConfig = {
    targetMode: 'full-compose',
    baseUrl: undefined,
    repeat: 1,
    seed: 42,
    flakeRetry: false,
    socketTransport: 'websocket',
    duration: {
        warmupMs: 1000,
        durationMs: 20000,
        cooldownMs: 1000,
        soakMs: 5000,
    },
    load: {
        users: 2,
        machinesPerUser: 2,
        sessionsPerUser: 2,
        rpcListenersPerUser: 1,
        rpcCallsPerSecond: 10,
        messagesPerSecond: 50,
        reconnectRate: 1,
        mixedSessionMode: 'representative',
        mixedSetupConcurrency: 4,
        mixedConnectConcurrency: 8,
        mixedRunnerShards: 1,
    },
    orchestration: {
        rollingRestartEnabled: false,
        killTarget: 'none',
        expectedApiReplicas: 4,
        expectedWorkerReplicas: 2,
    },
    compose: {
        apiReplicas: 4,
        workerReplicas: 2,
        imageBuildStrategy: 'never',
        reuseRunningTopology: false,
        frontDoorMode: 'gateway',
        loadGenerationMode: 'compose-network',
        metricsEnabled: true,
        filesBackend: 's3',
    },
    artifacts: {
        saveArtifactsOnSuccess: false,
        metricsScrapeEnabled: false,
        keepTopologyOnFailure: false,
        summaryOutputPath: undefined,
    },
};

describe('runMixedRealisticShardCli', () => {
    it('writes the shard result returned by the worker', async () => {
        const workDir = mkdtempSync(join(tmpdir(), 'happier-mixed-realistic-cli-'));
        const requestPath = join(workDir, 'request.json');
        const outputPath = join(workDir, 'result.json');
        const result = {
            shardIndex: 0,
            authIndexStart: 0,
            authIndexEndExclusive: 2,
            counts: {
                sessions: 8,
                activeSessions: 4,
                machineSockets: 8,
                verifiedSessions: 2,
                messagesSent: 20,
                streamSegmentsSent: 10,
                rpcCalls: 6,
                rpcListeners: 4,
                reconnectsTriggered: 2,
            },
            failures: {
                duplicateLocalIds: 0,
                messageAckFailures: 0,
                rpcFailures: 0,
                reconnectFailures: 0,
            },
            latencySamples: {
                ackLatencies: [10, 20],
                rpcLatencies: [30],
                streamDispatchLatencies: [5],
            },
            stageDurationsMs: {
                authMs: 100,
                provisionMs: 200,
                connectMs: 300,
                trafficMs: 400,
                verificationMs: 50,
            },
            provisioningStages: {
                session_create: { completedCount: 8, failedCount: 0, totalMs: 400 },
                machine_create: { completedCount: 8, failedCount: 0, totalMs: 500 },
                access_key_create: { completedCount: 8, failedCount: 0, totalMs: 600 },
            },
            connectivitySnapshot: {
                userDevices: {
                    total: 2,
                    connected: 2,
                    disconnectedAuthIndexes: [],
                    eventSummary: {
                        lastConnectErrorMessageCounts: {},
                        lastDisconnectReasonCounts: {},
                        missingLastConnectErrorCount: 0,
                        missingLastDisconnectCount: 0,
                    },
                    disconnectedSample: [],
                },
                machineCollectors: {
                    total: 8,
                    connected: 8,
                    disconnectedCount: 0,
                    disconnectedAuthIndexes: [],
                    eventSummary: {
                        lastConnectErrorMessageCounts: {},
                        lastDisconnectReasonCounts: {},
                        missingLastConnectErrorCount: 0,
                        missingLastDisconnectCount: 0,
                    },
                    disconnectedSample: [],
                },
            },
            progressSnapshots: [],
            rpcReadiness: {
                probed: 4,
                successful: 4,
                failed: 0,
                ledger: [],
            },
        };

        const request = {
            baseUrl: 'http://gateway:8080',
            controlPlaneBaseUrl: 'http://api:53288',
            config: baseConfig,
            shardPlan: {
                shardIndex: 0,
                authIndexStart: 0,
                userCount: 2,
                mixedSetupConcurrency: 4,
                mixedConnectConcurrency: 8,
            },
            outputPath,
        };

        const readFileSyncImpl = ((_: Parameters<typeof readFileSyncType>[0], __?: Parameters<typeof readFileSyncType>[1]) =>
            JSON.stringify(request)) as typeof readFileSyncType;
        const writeFileSyncImpl: typeof writeFileSyncType = vi.fn((_path, _data, _options) => undefined);

        await expect(runMixedRealisticShardCli([requestPath], {
            readFileSync: readFileSyncImpl,
            writeFileSync: writeFileSyncImpl,
            runMixedRealisticShardWork: vi.fn(async () => result),
            processStderrWrite: vi.fn(),
        })).resolves.toBeUndefined();

        expect(writeFileSyncImpl).toHaveBeenCalledWith(
            outputPath,
            `${JSON.stringify(result, null, 2)}\n`,
            'utf8',
        );
    });
});
