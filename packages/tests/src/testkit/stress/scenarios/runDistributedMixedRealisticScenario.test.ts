import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { RunDirs } from '../../runDir';
import type { StressConfig } from '../config/stressScenarioSchema';
import type { StartedStressTarget } from '../targets/stressTargetTypes';
import { runDistributedMixedRealisticScenario } from './runDistributedMixedRealisticScenario';

const config: StressConfig = {
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
        users: 4,
        machinesPerUser: 2,
        sessionsPerUser: 2,
        rpcListenersPerUser: 1,
        rpcCallsPerSecond: 10,
        messagesPerSecond: 50,
        reconnectRate: 1,
        mixedSessionMode: 'representative',
        mixedSetupConcurrency: 8,
        mixedConnectConcurrency: 8,
        mixedRunnerShards: 2,
        mixedActiveSessionPercent: 50,
        mixedStreamingSegmentsPerSecond: 0,
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
        metricsScrapeEnabled: true,
        keepTopologyOnFailure: false,
        summaryOutputPath: undefined,
    },
};

function createRunFixture(): RunDirs {
    const runDir = mkdtempSync(join(tmpdir(), 'happier-distributed-mixed-realistic-'));
    return {
        runId: 'run-id',
        runDir,
        testDir: (testName: string) => join(runDir, testName),
    };
}

function createTarget(overrides?: Partial<StartedStressTarget>): StartedStressTarget {
    return {
        mode: 'full-compose',
        baseUrl: 'http://127.0.0.1:43080',
        topology: {
            kind: 'full-compose',
            composeProjectName: 'compose-project',
            services: ['gateway', 'api', 'worker', 'loadgen'],
            expectedApiReplicas: 4,
            expectedWorkerReplicas: 2,
            resolvedApiReplicas: 4,
            resolvedWorkerReplicas: 2,
            baseUrl: 'http://127.0.0.1:43080',
            ports: { gateway: 43080 },
        },
        preserveForInspection: () => {},
        stop: async () => {},
        collectDiagnostics: async () => {},
        ...overrides,
    };
}

describe('runDistributedMixedRealisticScenario', () => {
    it('executes realistic shard workers inside the compose network and aggregates one combined summary', async () => {
        const run = createRunFixture();
        const composeFile = join(run.testDir('target'), 'topology', 'docker-compose.yml');
        const finalized = vi.fn(async () => ({
            summaryFile: join(run.runDir, 'summary.json'),
            manifestFile: join(run.runDir, 'manifest.json'),
        }));
        const execInService = vi.fn(async (_service: string, command: readonly string[]) => {
            expect(command.slice(0, 2)).toEqual(['sh', '-lc']);
            const shellCommand = command[2];
            expect(shellCommand).toMatch(
                /^mkdir -p \/stress-shared\/loadgen-node-diagnostics && node scripts\/runTsxEntrypoint\.mjs src\/testkit\/stress\/cli\/runMixedRealisticShard\.ts \/stress-shared\/loadgen\/shard-\d+\.request\.json >\/stress-shared\/loadgen\/shard-\d+\.stdout\.log 2>\/stress-shared\/loadgen\/shard-\d+\.stderr\.log$/,
            );
            if (typeof shellCommand !== 'string') {
                throw new Error('missing compose-network request path');
            }
            const requestPath = shellCommand.match(/(\/stress-shared\/loadgen\/shard-\d+\.request\.json)/u)?.[1];
            if (!requestPath) {
                throw new Error('missing compose-network request path');
            }
            const hostRequestPath = requestPath.replace('/stress-shared/loadgen', join(dirname(composeFile), 'loadgen'));
            const request = JSON.parse(readFileSync(hostRequestPath, 'utf8')) as {
                outputPath: string;
                baseUrl: string;
                controlPlaneBaseUrl?: string;
                controlPlaneBaseUrls?: readonly string[];
                shardPlan: {
                    shardIndex: number;
                    authIndexStart: number;
                    authIndexEndExclusive: number;
                    userCount: number;
                };
            };
            expect(request.baseUrl).toBe('http://gateway:8080');
            expect(request.controlPlaneBaseUrl).toBe('http://10.0.0.11:53288');
            expect(request.controlPlaneBaseUrls).toEqual([
                'http://10.0.0.11:53288',
                'http://10.0.0.12:53288',
                'http://10.0.0.13:53288',
                'http://10.0.0.14:53288',
            ]);
            const hostOutputPath = request.outputPath.replace('/stress-shared/loadgen', join(dirname(composeFile), 'loadgen'));
            writeFileSync(hostOutputPath, `${JSON.stringify({
                shardIndex: request.shardPlan.shardIndex,
                authIndexStart: request.shardPlan.authIndexStart,
                authIndexEndExclusive: request.shardPlan.authIndexEndExclusive,
                counts: {
                    sessions: request.shardPlan.userCount * 4,
                    activeSessions: request.shardPlan.userCount * 2,
                    machineSockets: request.shardPlan.userCount * 4,
                    verifiedSessions: 2,
                    messagesSent: request.shardPlan.userCount * 10,
                    streamSegmentsSent: request.shardPlan.userCount * 5,
                    rpcCalls: request.shardPlan.userCount * 3,
                    rpcListeners: request.shardPlan.userCount * 2,
                    reconnectsTriggered: request.shardPlan.userCount,
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
                    streamDispatchLatencies: [5, 6],
                },
                stageDurationsMs: {
                    authMs: 100,
                    provisionMs: 200,
                    connectMs: 300,
                    trafficMs: 400,
                    verificationMs: 50,
                },
                provisioningStages: {
                    session_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 400 },
                    machine_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 500 },
                    access_key_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 600 },
                },
                connectivitySnapshot: {
                    userDevices: {
                        total: request.shardPlan.userCount,
                        connected: request.shardPlan.userCount,
                        disconnectedAuthIndexes: [],
                        disconnectedSample: [],
                    },
                    machineCollectors: {
                        total: request.shardPlan.userCount * 4,
                        connected: request.shardPlan.userCount * 4,
                        disconnectedCount: 0,
                        disconnectedSample: [],
                    },
                },
                rpcReadiness: {
                    probed: request.shardPlan.userCount * 2,
                    successful: request.shardPlan.userCount * 2,
                    failed: 0,
                    ledger: [],
                },
            }, null, 2)}\n`, 'utf8');
            return 'ok';
        });
        const execInContainer = vi.fn(async (_containerId: string, command: readonly string[]) => {
            expect(command.slice(0, 2)).toEqual(['sh', '-lc']);
            const shellCommand = command[2];
            expect(shellCommand).toMatch(
                /^mkdir -p \/stress-shared\/loadgen-node-diagnostics && node scripts\/runTsxEntrypoint\.mjs src\/testkit\/stress\/cli\/runMixedRealisticShard\.ts \/stress-shared\/loadgen\/shard-\d+\.request\.json >\/stress-shared\/loadgen\/shard-\d+\.stdout\.log 2>\/stress-shared\/loadgen\/shard-\d+\.stderr\.log$/,
            );
            if (typeof shellCommand !== 'string') {
                throw new Error('missing compose-network request path');
            }
            const requestPath = shellCommand.match(/(\/stress-shared\/loadgen\/shard-\d+\.request\.json)/u)?.[1];
            if (!requestPath) {
                throw new Error('missing compose-network request path');
            }
            const hostRequestPath = requestPath.replace('/stress-shared/loadgen', join(dirname(composeFile), 'loadgen'));
            const request = JSON.parse(readFileSync(hostRequestPath, 'utf8')) as {
                outputPath: string;
                baseUrl: string;
                controlPlaneBaseUrl?: string;
                controlPlaneBaseUrls?: readonly string[];
                shardPlan: {
                    shardIndex: number;
                    authIndexStart: number;
                    authIndexEndExclusive: number;
                    userCount: number;
                };
            };
            const hostOutputPath = request.outputPath.replace('/stress-shared/loadgen', join(dirname(composeFile), 'loadgen'));
            writeFileSync(hostOutputPath, `${JSON.stringify({
                shardIndex: request.shardPlan.shardIndex,
                authIndexStart: request.shardPlan.authIndexStart,
                authIndexEndExclusive: request.shardPlan.authIndexEndExclusive,
                counts: {
                    sessions: request.shardPlan.userCount * 4,
                    activeSessions: request.shardPlan.userCount * 2,
                    machineSockets: request.shardPlan.userCount * 4,
                    verifiedSessions: 2,
                    messagesSent: request.shardPlan.userCount * 10,
                    streamSegmentsSent: request.shardPlan.userCount * 5,
                    rpcCalls: request.shardPlan.userCount * 3,
                    rpcListeners: request.shardPlan.userCount * 2,
                    reconnectsTriggered: request.shardPlan.userCount,
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
                    streamDispatchLatencies: [5, 6],
                },
                stageDurationsMs: {
                    authMs: 100,
                    provisionMs: 200,
                    connectMs: 300,
                    trafficMs: 400,
                    verificationMs: 50,
                },
                provisioningStages: {
                    session_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 400 },
                    machine_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 500 },
                    access_key_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 600 },
                },
                connectivitySnapshot: {
                    userDevices: {
                        total: request.shardPlan.userCount,
                        connected: request.shardPlan.userCount,
                        disconnectedAuthIndexes: [],
                        disconnectedSample: [],
                    },
                    machineCollectors: {
                        total: request.shardPlan.userCount * 4,
                        connected: request.shardPlan.userCount * 4,
                        disconnectedCount: 0,
                        disconnectedSample: [],
                    },
                },
                rpcReadiness: {
                    probed: request.shardPlan.userCount * 2,
                    successful: request.shardPlan.userCount * 2,
                    failed: 0,
                    ledger: [],
                },
            }, null, 2)}\n`, 'utf8');
            return 'ok';
        });

        await runDistributedMixedRealisticScenario({
            run,
            target: createTarget({
                artifacts: { composeFile },
                admin: {
                    execInService,
                    execInContainer,
                    listServiceContainers: vi.fn(async (service: string) => (
                        service === 'api'
                            ? [
                                { id: 'api-1', name: 'api-1', service: 'api', state: 'running', ipv4Addresses: ['10.0.0.11'] },
                                { id: 'api-2', name: 'api-2', service: 'api', state: 'running', ipv4Addresses: ['10.0.0.12'] },
                                { id: 'api-3', name: 'api-3', service: 'api', state: 'running', ipv4Addresses: ['10.0.0.13'] },
                                { id: 'api-4', name: 'api-4', service: 'api', state: 'running', ipv4Addresses: ['10.0.0.14'] },
                            ]
                            : [
                                { id: 'loadgen-1', name: 'loadgen-1', service: 'loadgen', state: 'running', ipv4Addresses: ['10.0.0.21'] },
                                { id: 'loadgen-2', name: 'loadgen-2', service: 'loadgen', state: 'running', ipv4Addresses: ['10.0.0.22'] },
                            ]
                    )),
                    writeGatewayConfig: vi.fn(async () => ''),
                    activateGatewayConfig: vi.fn(async () => {}),
                    startService: vi.fn(async () => {}),
                    stopService: vi.fn(async () => {}),
                    stopContainer: vi.fn(async () => {}),
                    killContainer: vi.fn(async () => {}),
                },
            }),
            config,
        }, {
            repoRootDir: () => '/repo/root',
            runLoggedCommand: vi.fn(async () => {
                throw new Error('host runner should not be used in compose-network mode');
            }),
            scrapeMixedRealisticFullComposeMetrics: vi.fn(async () => ({
                api: { websocket_connections_active: 5000 },
            })),
            finalizeStressScenario: finalized,
        });

        expect(execInService).toHaveBeenCalledWith('api', [
            'node',
            '-e',
            expect.stringContaining('targets.map(async (target) =>'),
            JSON.stringify(['10.0.0.11:9090', '10.0.0.12:9090', '10.0.0.13:9090', '10.0.0.14:9090']),
        ]);
        const loadgenCalls = execInContainer.mock.calls.filter((call) =>
            Array.isArray(call[1])
            && call[1][2]?.includes('runMixedRealisticShard.ts'),
        );
        expect(loadgenCalls).toHaveLength(2);
        expect(loadgenCalls[0]).toEqual(['loadgen-1', [
            'sh',
            '-lc',
            'mkdir -p /stress-shared/loadgen-node-diagnostics && node scripts/runTsxEntrypoint.mjs src/testkit/stress/cli/runMixedRealisticShard.ts /stress-shared/loadgen/shard-0.request.json >/stress-shared/loadgen/shard-0.stdout.log 2>/stress-shared/loadgen/shard-0.stderr.log',
        ]]);
        expect(loadgenCalls[1]).toEqual(['loadgen-2', [
            'sh',
            '-lc',
            'mkdir -p /stress-shared/loadgen-node-diagnostics && node scripts/runTsxEntrypoint.mjs src/testkit/stress/cli/runMixedRealisticShard.ts /stress-shared/loadgen/shard-1.request.json >/stress-shared/loadgen/shard-1.stdout.log 2>/stress-shared/loadgen/shard-1.stderr.log',
        ]]);
        expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
            status: 'passed',
            counts: expect.objectContaining({
                sessions: 16,
                activeSessions: 8,
                machineSockets: 16,
                messagesSent: 40,
                streamSegmentsSent: 20,
                rpcCalls: 12,
                reconnectsTriggered: 4,
            }),
            metrics: expect.objectContaining({
                api: { websocket_connections_active: 5000 },
                shardOutcomeSummary: expect.arrayContaining([
                    expect.objectContaining({
                        shardIndex: 0,
                        connectivityDeficit: {
                            userDevicesDisconnected: 0,
                            machineCollectorsDisconnected: 0,
                        },
                        counts: expect.objectContaining({
                            sessions: 8,
                            messagesSent: 20,
                        }),
                        connectivitySnapshot: expect.objectContaining({
                            userDevices: expect.objectContaining({
                                total: 2,
                                connected: 2,
                            }),
                        }),
                    }),
                    expect.objectContaining({
                        shardIndex: 1,
                        connectivityDeficit: {
                            userDevicesDisconnected: 0,
                            machineCollectorsDisconnected: 0,
                        },
                        counts: expect.objectContaining({
                            sessions: 8,
                            messagesSent: 20,
                        }),
                        connectivitySnapshot: expect.objectContaining({
                            machineCollectors: expect.objectContaining({
                                total: 8,
                                connected: 8,
                            }),
                        }),
                    }),
                ]),
                shardResults: expect.arrayContaining([
                    expect.objectContaining({
                        shardIndex: 0,
                        counts: expect.objectContaining({ sessions: 8 }),
                    }),
                    expect.objectContaining({
                        shardIndex: 1,
                        counts: expect.objectContaining({ sessions: 8 }),
                    }),
                ]),
            }),
        }));
    });

    it('preserves partial shard results in the combined failure summary when shard execution fails after writing output', async () => {
        const run = createRunFixture();
        const composeFile = join(run.testDir('target'), 'topology', 'docker-compose.yml');
        const finalized = vi.fn(async () => ({
            summaryFile: join(run.runDir, 'summary.json'),
            manifestFile: join(run.runDir, 'manifest.json'),
        }));
        const execInService = vi.fn(async (_service: string, command: readonly string[]) => {
            expect(command.slice(0, 2)).toEqual(['sh', '-lc']);
            const shellCommand = command[2];
            if (typeof shellCommand !== 'string') {
                throw new Error('missing compose-network request path');
            }
            const requestPath = shellCommand.match(/(\/stress-shared\/loadgen\/shard-\d+\.request\.json)/u)?.[1];
            if (!requestPath) {
                throw new Error('missing compose-network request path');
            }
            const stderrPath = shellCommand.match(/2>(\/stress-shared\/loadgen\/shard-\d+\.stderr\.log)/u)?.[1];
            const hostRequestPath = requestPath.replace('/stress-shared/loadgen', join(dirname(composeFile), 'loadgen'));
            const request = JSON.parse(readFileSync(hostRequestPath, 'utf8')) as {
                outputPath: string;
                shardPlan: {
                    shardIndex: number;
                    authIndexStart: number;
                    authIndexEndExclusive: number;
                    userCount: number;
                };
            };
            const hostOutputPath = request.outputPath.replace('/stress-shared/loadgen', join(dirname(composeFile), 'loadgen'));
            if (stderrPath) {
                const hostStderrPath = stderrPath.replace('/stress-shared/loadgen', join(dirname(composeFile), 'loadgen'));
                writeFileSync(hostStderrPath, '', 'utf8');
            }
            writeFileSync(hostOutputPath, `${JSON.stringify({
                shardIndex: request.shardPlan.shardIndex,
                authIndexStart: request.shardPlan.authIndexStart,
                authIndexEndExclusive: request.shardPlan.authIndexEndExclusive,
                counts: {
                    sessions: request.shardPlan.userCount * 4,
                    activeSessions: request.shardPlan.userCount,
                    machineSockets: request.shardPlan.userCount * 4,
                    verifiedSessions: 1,
                    messagesSent: request.shardPlan.userCount,
                    streamSegmentsSent: 0,
                    rpcCalls: request.shardPlan.userCount,
                    rpcListeners: request.shardPlan.userCount,
                    reconnectsTriggered: 0,
                },
                failures: {
                    duplicateLocalIds: 0,
                    messageAckFailures: 0,
                    rpcFailures: 0,
                    reconnectFailures: 0,
                },
                latencySamples: {
                    ackLatencies: [10],
                    rpcLatencies: [20],
                    streamDispatchLatencies: [],
                },
                stageDurationsMs: {
                    authMs: 10,
                    provisionMs: 20,
                    connectMs: 30,
                    trafficMs: 0,
                    verificationMs: 0,
                },
                provisioningStages: {
                    session_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 40 },
                    machine_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 50 },
                    access_key_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 60 },
                },
                connectivitySnapshot: {
                    userDevices: {
                        total: request.shardPlan.userCount,
                        connected: request.shardPlan.userCount - 1,
                        disconnectedAuthIndexes: [request.shardPlan.authIndexStart],
                        eventSummary: {
                            lastConnectErrorMessageCounts: { upstream_error: 1 },
                            lastDisconnectReasonCounts: { 'transport close': 1 },
                            missingLastConnectErrorCount: 0,
                            missingLastDisconnectCount: 0,
                        },
                        disconnectedSample: [],
                    },
                    machineCollectors: {
                        total: request.shardPlan.userCount * 4,
                        connected: request.shardPlan.userCount * 4 - 1,
                        disconnectedCount: 1,
                        disconnectedAuthIndexes: [request.shardPlan.authIndexStart],
                        eventSummary: {
                            lastConnectErrorMessageCounts: { upstream_error: 1 },
                            lastDisconnectReasonCounts: { 'transport close': 1 },
                            missingLastConnectErrorCount: 0,
                            missingLastDisconnectCount: 0,
                        },
                        disconnectedSample: [],
                    },
                },
                rpcReadiness: {
                    probed: request.shardPlan.userCount,
                    successful: request.shardPlan.userCount - 1,
                    failed: 1,
                    ledger: [],
                },
                trafficFailure: {
                    stage: 'rpc_register',
                    method: `session-${request.shardPlan.shardIndex}:stress.mixed.rpc.0`,
                    machineId: `machine-${request.shardPlan.shardIndex}`,
                    authIndex: request.shardPlan.authIndexStart,
                    rpcCallsCompleted: 0,
                    messagesSentBeforeFailure: 1,
                    reconnectsTriggered: 0,
                    rpcReadinessProbed: request.shardPlan.userCount,
                    rpcReadinessFailed: 1,
                    error: `rpc-register timed out for shard ${request.shardPlan.shardIndex}`,
                },
            }, null, 2)}\n`, 'utf8');
            throw new Error(`shard ${request.shardPlan.shardIndex} failed after writing output`);
        });

        await expect(runDistributedMixedRealisticScenario({
            run,
            target: createTarget({
                artifacts: { composeFile },
                admin: {
                    execInService,
                    listServiceContainers: vi.fn(async () => []),
                    writeGatewayConfig: vi.fn(async () => ''),
                    activateGatewayConfig: vi.fn(async () => {}),
                    startService: vi.fn(async () => {}),
                    stopService: vi.fn(async () => {}),
                    stopContainer: vi.fn(async () => {}),
                    killContainer: vi.fn(async () => {}),
                },
            }),
            config,
        }, {
            repoRootDir: () => '/repo/root',
            runLoggedCommand: vi.fn(async () => {
                throw new Error('host runner should not be used in compose-network mode');
            }),
            scrapeMixedRealisticFullComposeMetrics: vi.fn(async () => ({
                api: { websocket_connections_active: 1000 },
            })),
            finalizeStressScenario: finalized,
        })).rejects.toThrow('shard 0 failed after writing output; shard 1 failed after writing output');

        expect(
            readFileSync(join(dirname(composeFile), 'loadgen', 'shard-0.stderr.log'), 'utf8'),
        ).toContain('shard 0 failed after writing output');
        expect(
            readFileSync(join(dirname(composeFile), 'loadgen', 'shard-1.stderr.log'), 'utf8'),
        ).toContain('shard 1 failed after writing output');

        expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
            status: 'failed',
            counts: expect.objectContaining({
                sessions: 16,
                activeSessions: 4,
                machineSockets: 16,
                messagesSent: 4,
                rpcCalls: 4,
                rpcListeners: 4,
            }),
            metrics: expect.objectContaining({
                api: { websocket_connections_active: 1000 },
                provisioningStages: expect.anything(),
                shardOutcomeSummary: expect.arrayContaining([
                    expect.objectContaining({
                        shardIndex: 0,
                        connectivityDeficit: {
                            userDevicesDisconnected: 1,
                            machineCollectorsDisconnected: 1,
                        },
                        machineCollectorDisconnectedAuthIndexes: [0],
                        machineCollectorDisconnectedAuthIndexModuloCounts: {
                            moduloBase: 4,
                            counts: { '0': 1 },
                        },
                        counts: expect.objectContaining({
                            sessions: 8,
                            messagesSent: 2,
                        }),
                        trafficFailure: {
                            stage: 'rpc_register',
                            method: 'session-0:stress.mixed.rpc.0',
                            machineId: 'machine-0',
                            authIndex: 0,
                            rpcCallsCompleted: 0,
                            messagesSentBeforeFailure: 1,
                            reconnectsTriggered: 0,
                            rpcReadinessProbed: 2,
                            rpcReadinessFailed: 1,
                            error: 'rpc-register timed out for shard 0',
                        },
                        connectivitySnapshot: expect.objectContaining({
                            userDevices: expect.objectContaining({
                                total: 2,
                                connected: 1,
                            }),
                            machineCollectors: expect.objectContaining({
                                total: 8,
                                connected: 7,
                            }),
                        }),
                    }),
                    expect.objectContaining({
                        shardIndex: 1,
                        connectivityDeficit: {
                            userDevicesDisconnected: 1,
                            machineCollectorsDisconnected: 1,
                        },
                        machineCollectorDisconnectedAuthIndexes: [2],
                        machineCollectorDisconnectedAuthIndexModuloCounts: {
                            moduloBase: 4,
                            counts: { '2': 1 },
                        },
                        counts: expect.objectContaining({
                            sessions: 8,
                            messagesSent: 2,
                        }),
                        trafficFailure: {
                            stage: 'rpc_register',
                            method: 'session-1:stress.mixed.rpc.0',
                            machineId: 'machine-1',
                            authIndex: 2,
                            rpcCallsCompleted: 0,
                            messagesSentBeforeFailure: 1,
                            reconnectsTriggered: 0,
                            rpcReadinessProbed: 2,
                            rpcReadinessFailed: 1,
                            error: 'rpc-register timed out for shard 1',
                        },
                    }),
                ]),
                connectivitySnapshot: expect.objectContaining({
                    userDevices: expect.objectContaining({
                        total: 4,
                        connected: 2,
                        eventSummary: {
                            lastConnectErrorMessageCounts: { upstream_error: 2 },
                            lastDisconnectReasonCounts: { 'transport close': 2 },
                            missingLastConnectErrorCount: 0,
                            missingLastDisconnectCount: 0,
                        },
                    }),
                    machineCollectors: expect.objectContaining({
                        total: 16,
                        connected: 14,
                        disconnectedCount: 2,
                        disconnectedAuthIndexes: [0, 2],
                        eventSummary: {
                            lastConnectErrorMessageCounts: { upstream_error: 2 },
                            lastDisconnectReasonCounts: { 'transport close': 2 },
                            missingLastConnectErrorCount: 0,
                            missingLastDisconnectCount: 0,
                        },
                    }),
                }),
                connectivityDeficitPatterns: {
                    machineCollectorDisconnectedAuthIndexModuloCounts: {
                        moduloBase: 4,
                        counts: { '0': 1, '2': 1 },
                    },
                },
                shardResults: expect.arrayContaining([
                    expect.objectContaining({
                        shardIndex: 0,
                        counts: expect.objectContaining({ sessions: 8 }),
                    }),
                    expect.objectContaining({
                        shardIndex: 1,
                        counts: expect.objectContaining({ sessions: 8 }),
                    }),
                ]),
            }),
        }));
    });

    it('preserves shard progress snapshots when a compose-network shard fails before writing a result file', async () => {
        const run = createRunFixture();
        const composeFile = join(run.testDir('target'), 'topology', 'docker-compose.yml');
        const finalized = vi.fn(async () => ({
            summaryFile: join(run.runDir, 'summary.json'),
            manifestFile: join(run.runDir, 'manifest.json'),
        }));
        const execInService = vi.fn(async (_service: string, command: readonly string[]) => {
            expect(command.slice(0, 2)).toEqual(['sh', '-lc']);
            const shellCommand = command[2];
            if (typeof shellCommand !== 'string') {
                throw new Error('missing compose-network request path');
            }
            const requestPath = shellCommand.match(/(\/stress-shared\/loadgen\/shard-\d+\.request\.json)/u)?.[1];
            if (!requestPath) {
                throw new Error('missing compose-network request path');
            }
            const hostRequestPath = requestPath.replace('/stress-shared/loadgen', join(dirname(composeFile), 'loadgen'));
            const request = JSON.parse(readFileSync(hostRequestPath, 'utf8')) as {
                progressPath?: string;
                shardPlan: {
                    shardIndex: number;
                    authIndexStart: number;
                    userCount: number;
                };
            };
            const hostProgressPath = request.progressPath?.replace('/stress-shared/loadgen', join(dirname(composeFile), 'loadgen'));
            if (!hostProgressPath) {
                throw new Error('missing compose-network progress path');
            }
            writeFileSync(hostProgressPath, `${JSON.stringify([
                {
                    shardIndex: request.shardPlan.shardIndex,
                    phase: 'auth',
                    status: 'completed',
                    at: '2026-04-21T19:30:00.000Z',
                    memoryUsage: {
                        rssBytes: 100,
                        heapTotalBytes: 80,
                        heapUsedBytes: 60,
                        externalBytes: 5,
                        arrayBuffersBytes: 2,
                    },
                    counts: {
                        authsCreated: request.shardPlan.userCount,
                        userDeviceGroups: 0,
                        userScopedSockets: 0,
                        sessions: 0,
                        machineCollectors: 0,
                        verificationSessions: 0,
                        listeners: 0,
                        ackLatencySamples: 0,
                        rpcLatencySamples: 0,
                        streamDispatchLatencySamples: 0,
                        rpcReadinessEntries: 0,
                    },
                    stageDurationsMs: {
                        authMs: 10,
                        provisionMs: 0,
                        connectMs: 0,
                        trafficMs: 0,
                        verificationMs: 0,
                    },
                },
                {
                    shardIndex: request.shardPlan.shardIndex,
                    phase: 'bootstrap',
                    subphase: 'connect_wait',
                    status: 'failed',
                    at: '2026-04-21T19:30:01.000Z',
                    memoryUsage: {
                        rssBytes: 200,
                        heapTotalBytes: 160,
                        heapUsedBytes: 120,
                        externalBytes: 8,
                        arrayBuffersBytes: 3,
                    },
                    counts: {
                        authsCreated: request.shardPlan.userCount,
                        userDeviceGroups: request.shardPlan.userCount,
                        userScopedSockets: request.shardPlan.userCount,
                        openedUserScopedSockets: 0,
                        connectedUserScopedSockets: 0,
                        sessions: request.shardPlan.userCount,
                        machineCollectors: request.shardPlan.userCount,
                        openedMachineCollectors: 0,
                        connectedMachineCollectors: 0,
                        verificationSessions: 1,
                        listeners: 0,
                        ackLatencySamples: 0,
                        rpcLatencySamples: 0,
                        streamDispatchLatencySamples: 0,
                        rpcReadinessEntries: 0,
                    },
                    stageDurationsMs: {
                        authMs: 10,
                        provisionMs: 20,
                        connectMs: 0,
                        trafficMs: 0,
                        verificationMs: 0,
                    },
                    error: `bootstrap failed on shard ${request.shardPlan.shardIndex}`,
                },
            ], null, 2)}\n`, 'utf8');
            throw new Error(`shard ${request.shardPlan.shardIndex} died before writing result`);
        });

        await expect(runDistributedMixedRealisticScenario({
            run,
            target: createTarget({
                artifacts: { composeFile },
                admin: {
                    execInService,
                    listServiceContainers: vi.fn(async () => []),
                    writeGatewayConfig: vi.fn(async () => ''),
                    activateGatewayConfig: vi.fn(async () => {}),
                    startService: vi.fn(async () => {}),
                    stopService: vi.fn(async () => {}),
                    stopContainer: vi.fn(async () => {}),
                    killContainer: vi.fn(async () => {}),
                },
            }),
            config,
        }, {
            repoRootDir: () => '/repo/root',
            runLoggedCommand: vi.fn(async () => {
                throw new Error('host runner should not be used in compose-network mode');
            }),
            scrapeMixedRealisticFullComposeMetrics: vi.fn(async () => ({
                api: { websocket_connections_active: 1000 },
            })),
            finalizeStressScenario: finalized,
        })).rejects.toThrow('shard 0 died before writing result; shard 1 died before writing result');

        expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
            status: 'failed',
            counts: expect.objectContaining({
                sessions: 0,
                machineSockets: 0,
                messagesSent: 0,
            }),
            metrics: expect.objectContaining({
                shardOutcomeSummary: expect.arrayContaining([
                    expect.objectContaining({
                        shardIndex: 0,
                        progressResourceEnvelope: {
                            sampleCount: 2,
                            peakRssBytes: 200,
                            peakHeapUsedBytes: 120,
                            peakHeapTotalBytes: 160,
                            peakExternalBytes: 8,
                            peakArrayBuffersBytes: 3,
                            peakAt: {
                                phase: 'bootstrap',
                                subphase: 'connect_wait',
                                status: 'failed',
                            },
                        },
                        latestProgress: expect.objectContaining({
                            phase: 'bootstrap',
                            subphase: 'connect_wait',
                            status: 'failed',
                            error: 'bootstrap failed on shard 0',
                            counts: expect.objectContaining({
                                connectedUserScopedSockets: 0,
                                connectedMachineCollectors: 0,
                            }),
                        }),
                    }),
                    expect.objectContaining({
                        shardIndex: 1,
                        progressResourceEnvelope: {
                            sampleCount: 2,
                            peakRssBytes: 200,
                            peakHeapUsedBytes: 120,
                            peakHeapTotalBytes: 160,
                            peakExternalBytes: 8,
                            peakArrayBuffersBytes: 3,
                            peakAt: {
                                phase: 'bootstrap',
                                subphase: 'connect_wait',
                                status: 'failed',
                            },
                        },
                        latestProgress: expect.objectContaining({
                            phase: 'bootstrap',
                            subphase: 'connect_wait',
                            status: 'failed',
                            error: 'bootstrap failed on shard 1',
                            counts: expect.objectContaining({
                                connectedUserScopedSockets: 0,
                                connectedMachineCollectors: 0,
                            }),
                        }),
                    }),
                ]),
                shardResults: [],
                shardProgressSummary: expect.objectContaining({
                    totalSnapshots: 4,
                    latestByShard: expect.arrayContaining([
                        expect.objectContaining({
                            shardIndex: 0,
                            phase: 'bootstrap',
                            subphase: 'connect_wait',
                            status: 'failed',
                        }),
                        expect.objectContaining({
                            shardIndex: 1,
                            phase: 'bootstrap',
                            subphase: 'connect_wait',
                            status: 'failed',
                        }),
                    ]),
                }),
                shardProgressSnapshots: expect.arrayContaining([
                    expect.objectContaining({
                        shardIndex: 0,
                        phase: 'auth',
                        status: 'completed',
                    }),
                    expect.objectContaining({
                        shardIndex: 1,
                        phase: 'bootstrap',
                        subphase: 'connect_wait',
                        status: 'failed',
                    }),
                ]),
            }),
        }));
    });

    it('reuses the canonical realistic API peak metric set for distributed realistic peak sampling', async () => {
        vi.resetModules();

        const finalized = vi.fn(async () => ({
            summaryFile: '/tmp/summary.json',
            manifestFile: '/tmp/manifest.json',
        }));
        const stopPeakSampler = vi.fn(async () => ({
            replicas: [{
                target: '10.0.0.11:9090',
                containerId: 'api-1',
                containerName: 'api-1',
                values: {
                    runtime_rss_bytes: 100,
                    runtime_heap_used_bytes: 50,
                    websocket_connections_active: 8,
                    engineio_connections_active: 12,
                },
            }],
            signalEvents: [{
                target: '10.0.0.11:9090',
                containerId: 'api-1',
                containerName: 'api-1',
                valueKey: 'runtime_heap_space_used_old_space_bytes',
                threshold: 268435456,
                observedValue: 301989888,
                signal: 'SIGUSR2',
            }],
        }));
        const stopContainerMemoryPeakSampler = vi.fn(async () => ({
            containers: [{
                service: 'api',
                containerId: 'api-1',
                containerName: 'api-1',
                peakMemoryUsageBytes: 512,
                memoryLimitBytes: 4096,
                peakMemoryPercent: 12.5,
                peakPids: 32,
            }],
        }));
        const startClusterServiceMetricPeakSampler = vi.fn(() => ({
            stop: stopPeakSampler,
        }));
        const startContainerMemoryPeakSampler = vi.fn(() => ({
            stop: stopContainerMemoryPeakSampler,
        }));

        vi.doMock('./fullComposeScenarioSupport', async () => {
            const actual = await vi.importActual<typeof import('./fullComposeScenarioSupport')>('./fullComposeScenarioSupport');
            return {
                ...actual,
                startContainerMemoryPeakSampler,
                startClusterServiceMetricPeakSampler,
            };
        });

        const { runDistributedMixedRealisticScenario: runScenario } = await import('./runDistributedMixedRealisticScenario');

        const scrapeMixedRealisticFullComposeMetrics = vi.fn(async () => ({
            api: {
                websocket_connections_active: 5000,
                engineio_connections_active: 7000,
            },
        }));

        await runScenario({
            run: createRunFixture(),
            target: createTarget({
                artifacts: { composeFile: '/tmp/compose.yml' },
            }),
            config: {
                ...config,
                compose: {
                    ...config.compose,
                    loadGenerationMode: 'host',
                    apiHeapDiagnosticSignal: 'SIGUSR2',
                    apiHeapDiagnosticOldSpaceThresholdBytes: 268435456,
                },
            } as typeof config & {
                compose: typeof config.compose & {
                    apiHeapDiagnosticSignal: string;
                    apiHeapDiagnosticOldSpaceThresholdBytes: number;
                };
            },
        }, {
            repoRootDir: () => '/repo/root',
            runLoggedCommand: vi.fn(async ({ args }: { args: readonly string[] }) => {
                const requestPath = args.at(-1);
                if (!requestPath) {
                    throw new Error('missing host shard request path');
                }
                const request = JSON.parse(readFileSync(requestPath, 'utf8')) as {
                    outputPath: string;
                    shardPlan: {
                        shardIndex: number;
                        authIndexStart: number;
                        authIndexEndExclusive: number;
                        userCount: number;
                    };
                };
                writeFileSync(request.outputPath, `${JSON.stringify({
                    shardIndex: request.shardPlan.shardIndex,
                    authIndexStart: request.shardPlan.authIndexStart,
                    authIndexEndExclusive: request.shardPlan.authIndexEndExclusive,
                    counts: {
                        sessions: request.shardPlan.userCount * 4,
                        activeSessions: request.shardPlan.userCount * 2,
                        machineSockets: request.shardPlan.userCount * 4,
                        verifiedSessions: 1,
                        messagesSent: 0,
                        streamSegmentsSent: 0,
                        rpcCalls: 0,
                        rpcListeners: 0,
                        reconnectsTriggered: 0,
                    },
                    failures: {
                        duplicateLocalIds: 0,
                        messageAckFailures: 0,
                        rpcFailures: 0,
                        reconnectFailures: 0,
                    },
                    latencySamples: {
                        ackLatencies: [],
                        rpcLatencies: [],
                        streamDispatchLatencies: [],
                    },
                    stageDurationsMs: {
                        authMs: 1,
                        provisionMs: 1,
                        connectMs: 1,
                        trafficMs: 0,
                        verificationMs: 0,
                    },
                    provisioningStages: {
                        session_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 1 },
                        machine_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 1 },
                        access_key_create: { completedCount: request.shardPlan.userCount * 4, failedCount: 0, totalMs: 1 },
                    },
                    connectivitySnapshot: {
                        userDevices: {
                            total: request.shardPlan.userCount,
                            connected: request.shardPlan.userCount,
                            disconnectedAuthIndexes: [],
                            disconnectedSample: [],
                        },
                        machineCollectors: {
                            total: request.shardPlan.userCount * 4,
                            connected: request.shardPlan.userCount * 4,
                            disconnectedCount: 0,
                            disconnectedSample: [],
                        },
                    },
                    rpcReadiness: {
                        probed: 0,
                        successful: 0,
                        failed: 0,
                        ledger: [],
                    },
                }, null, 2)}\n`, 'utf8');
            }),
            scrapeMixedRealisticFullComposeMetrics,
            finalizeStressScenario: finalized,
        });

        expect(startClusterServiceMetricPeakSampler).toHaveBeenCalledWith(expect.objectContaining({
            metricNames: expect.arrayContaining([
                'runtime_rss_bytes',
                'runtime_heap_used_bytes',
                'runtime_total_physical_size_bytes',
                'runtime_global_handles_size_bytes',
                'websocket_connections_active',
                'auth_token_cache_entries',
                'engineio_connections_active',
            ]),
            selectors: expect.arrayContaining([
                expect.objectContaining({ alias: 'provision_auth_create_requests_total' }),
                expect.objectContaining({ alias: 'provision_auth_create_inflight' }),
                expect.objectContaining({ alias: 'runtime_heap_space_size_old_space_bytes' }),
                expect.objectContaining({ alias: 'runtime_heap_space_available_old_space_bytes' }),
                expect.objectContaining({ alias: 'runtime_heap_space_size_new_space_bytes' }),
                expect.objectContaining({ alias: 'runtime_heap_space_available_new_space_bytes' }),
                expect.objectContaining({ alias: 'runtime_heap_space_size_large_object_space_bytes' }),
                expect.objectContaining({ alias: 'runtime_heap_space_available_large_object_space_bytes' }),
            ]),
            thresholdSignals: [{
                valueKey: 'runtime_heap_space_used_old_space_bytes',
                threshold: 268435456,
                signal: 'SIGUSR2',
            }],
        }));
        expect(scrapeMixedRealisticFullComposeMetrics).toHaveBeenCalledWith(expect.objectContaining({
            apiReplicaPeakMetrics: [
                expect.objectContaining({
                    values: expect.objectContaining({
                        engineio_connections_active: 12,
                    }),
                }),
            ],
            apiReplicaDiagnosticSignals: expect.objectContaining({
                triggered: [{
                    target: '10.0.0.11:9090',
                    containerId: 'api-1',
                    containerName: 'api-1',
                    valueKey: 'runtime_heap_space_used_old_space_bytes',
                    threshold: 268435456,
                    observedValue: 301989888,
                    signal: 'SIGUSR2',
                }],
            }),
            containerMemoryPeakMetrics: [
                expect.objectContaining({
                    service: 'api',
                    peakMemoryUsageBytes: 512,
                }),
            ],
        }));
        expect(finalized).toHaveBeenCalledWith(expect.objectContaining({
            metrics: expect.objectContaining({
                api: expect.objectContaining({
                    engineio_connections_active: 7000,
                }),
            }),
        }));
    });
});
