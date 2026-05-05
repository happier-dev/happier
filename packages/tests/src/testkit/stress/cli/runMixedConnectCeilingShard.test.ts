import { mkdtempSync, type readFileSync as readFileSyncType, type writeFileSync as writeFileSyncType } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { StressConfig } from '../config/stressScenarioSchema';
import { runMixedConnectCeilingShardCli } from './runMixedConnectCeilingShard';

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
        rpcCallsPerSecond: 20,
        messagesPerSecond: 1000,
        reconnectRate: 2,
        mixedSessionMode: 'presence-fan-in',
        mixedSetupConcurrency: 8,
        mixedConnectConcurrency: 16,
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
        metricsEnabled: true,
        filesBackend: 's3',
    },
    artifacts: {
        saveArtifactsOnSuccess: false,
        metricsScrapeEnabled: true,
        keepTopologyOnFailure: false,
        summaryOutputPath: undefined,
    },
};

describe('runMixedConnectCeilingShardCli', () => {
    it('writes a partial shard result before failing when the worker exposes partialResult', async () => {
        const workDir = mkdtempSync(join(tmpdir(), 'happier-mixed-connect-cli-'));
        const requestPath = join(workDir, 'request.json');
        const outputPath = join(workDir, 'result.json');
        const partialResult = {
            shardIndex: 0,
            authIndexStart: 0,
            authIndexEndExclusive: 2,
            userDevicesTotal: 2,
            connectedUserDevices: 2,
            machineCollectorsTotal: 8,
            connectedMachineCollectors: 6,
            connectivitySnapshot: {
                userDevices: {
                    total: 2,
                    connected: 2,
                    disconnectedAuthIndexes: [],
                    disconnectedSample: [],
                },
                machineCollectors: {
                    total: 8,
                    connected: 6,
                    disconnectedCount: 2,
                    disconnectedSample: [],
                },
            },
            stageDurationsMs: {
                authMs: 100,
                provisionMs: 200,
                connectMs: 300,
            },
            provisioningStages: {
                session_create: { completedCount: 2, failedCount: 0, totalMs: 400 },
                machine_create: { completedCount: 8, failedCount: 0, totalMs: 500 },
                access_key_create: { completedCount: 6, failedCount: 1, totalMs: 600 },
            },
        };

        const request = {
            baseUrl: 'http://127.0.0.1:43080',
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
        const workerError = Object.assign(new Error('boom'), {
            partialResult,
        });

        await expect(runMixedConnectCeilingShardCli([requestPath], {
            readFileSync: readFileSyncImpl,
            writeFileSync: writeFileSyncImpl,
            runMixedConnectCeilingShardWork: vi.fn(async () => {
                throw workerError;
            }),
            processStderrWrite: vi.fn(),
        })).rejects.toThrow(/boom/);

        expect(writeFileSyncImpl).toHaveBeenNthCalledWith(
            1,
            outputPath,
            `${JSON.stringify(partialResult, null, 2)}\n`,
            'utf8',
        );
    });

    it('persists progress snapshots when the shard worker reports them', async () => {
        const workDir = mkdtempSync(join(tmpdir(), 'happier-mixed-connect-cli-progress-'));
        const requestPath = join(workDir, 'request.json');
        const outputPath = join(workDir, 'result.json');
        const progressPath = join(workDir, 'progress.json');
        const progressSnapshot = {
            phase: 'provision',
            shardIndex: 0,
            authIndexStart: 0,
            authIndexEndExclusive: 2,
            userDevicesTotal: 2,
            connectedUserDevices: 0,
            machineCollectorsTotal: 4,
            connectedMachineCollectors: 0,
            connectivitySnapshot: {
                userDevices: {
                    total: 2,
                    connected: 0,
                    disconnectedAuthIndexes: [0, 1],
                    disconnectedSample: [],
                },
                machineCollectors: {
                    total: 4,
                    connected: 0,
                    disconnectedCount: 4,
                    disconnectedSample: [],
                },
            },
            stageDurationsMs: {
                authMs: 100,
                provisionMs: 200,
                connectMs: 0,
            },
            provisioningStages: {
                session_create: { completedCount: 2, failedCount: 0, totalMs: 400 },
                machine_create: { completedCount: 4, failedCount: 0, totalMs: 500 },
                access_key_create: { completedCount: 0, failedCount: 1, totalMs: 60 },
            },
        };
        const finalResult = {
            ...progressSnapshot,
            connectedUserDevices: 2,
            connectedMachineCollectors: 4,
            phase: 'complete',
            connectivitySnapshot: {
                userDevices: {
                    total: 2,
                    connected: 2,
                    disconnectedAuthIndexes: [],
                    disconnectedSample: [],
                },
                machineCollectors: {
                    total: 4,
                    connected: 4,
                    disconnectedCount: 0,
                    disconnectedSample: [],
                },
            },
            stageDurationsMs: {
                authMs: 100,
                provisionMs: 200,
                connectMs: 300,
            },
        };

        const request = {
            baseUrl: 'http://127.0.0.1:43080',
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
            progressPath,
        };

        const readFileSyncImpl = ((_: Parameters<typeof readFileSyncType>[0], __?: Parameters<typeof readFileSyncType>[1]) =>
            JSON.stringify(request)) as typeof readFileSyncType;
        const writeFileSyncImpl: typeof writeFileSyncType = vi.fn((_path, _data, _options) => undefined);
        const runMixedConnectCeilingShardWork = vi.fn(async (params) => {
            await params.onProgress?.(progressSnapshot);
            return finalResult;
        });

        await expect(runMixedConnectCeilingShardCli([requestPath], {
            readFileSync: readFileSyncImpl,
            writeFileSync: writeFileSyncImpl,
            runMixedConnectCeilingShardWork,
            processStderrWrite: vi.fn(),
        })).resolves.toBeUndefined();

        expect(runMixedConnectCeilingShardWork).toHaveBeenCalledWith(expect.objectContaining({
            baseUrl: 'http://127.0.0.1:43080',
            controlPlaneBaseUrl: 'http://api:53288',
        }));

        expect(writeFileSyncImpl).toHaveBeenNthCalledWith(
            1,
            progressPath,
            `${JSON.stringify(progressSnapshot, null, 2)}\n`,
            'utf8',
        );
        expect(writeFileSyncImpl).toHaveBeenNthCalledWith(
            2,
            outputPath,
            `${JSON.stringify(finalResult, null, 2)}\n`,
            'utf8',
        );
    });
});
