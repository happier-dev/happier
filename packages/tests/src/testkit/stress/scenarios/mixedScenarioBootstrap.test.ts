import { describe, expect, it, vi } from 'vitest';

import type { StressConfig } from '../config/stressScenarioSchema';
import type { SocketCollector } from '../../socketClient';
import type { MixedRealisticWorkload } from './mixedRealisticWorkload';
import { runMixedScenarioBootstrap } from './mixedScenarioBootstrap';

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
            messagesPerSecond: 100,
            reconnectRate: 1,
            mixedSessionMode: 'presence-fan-in',
            mixedSetupConcurrency: 2,
            mixedConnectConcurrency: 4,
            mixedSocketConnectTimeoutMs: 15000,
            mixedCaptureSocketEvents: true,
        },
    orchestration: {
        rollingRestartEnabled: false,
        killTarget: 'none',
        expectedApiReplicas: 2,
        expectedWorkerReplicas: 1,
    },
    compose: {
        apiReplicas: 2,
        workerReplicas: 1,
        imageBuildStrategy: 'never',
        reuseRunningTopology: false,
        frontDoorMode: 'gateway',
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

function createWorkload(params: {
    sessionPlans: MixedRealisticWorkload['sessionPlans'];
    rpcListenerCount: number;
    rpcReadinessProbeCount: number;
    messageCount: number;
    reconnectCycles: number;
    verificationSessionCount: number;
    presencePulseCollectorCount: number;
    streamSegmentCount?: number;
}): MixedRealisticWorkload {
    return {
        sessionCount: params.sessionPlans.length,
        activeSessionCount: params.sessionPlans.length,
        sessionPlans: params.sessionPlans,
        sessionPlanCount: params.sessionPlans.length,
        rpcListenerCount: params.rpcListenerCount,
        rpcReadinessProbeCount: params.rpcReadinessProbeCount,
        messageCount: params.messageCount,
        streamSegmentCount: params.streamSegmentCount ?? 0,
        reconnectCycles: params.reconnectCycles,
        verificationSessionCount: params.verificationSessionCount,
        presencePulseCollectorCount: params.presencePulseCollectorCount,
    };
}

describe('runMixedScenarioBootstrap', () => {
    it('uses the control-plane base URL for setup, the front-door base URL for sockets, and preserves auth index offsets', async () => {
        const sessionCreateBaseUrls: string[] = [];
        const provisionBindingBaseUrls: string[] = [];
        const socketCollectorBaseUrls: string[] = [];
        const userScopedCollectorTokens: string[] = [];
        const connectedEvents: string[] = [];
        const bootstrapProgressSnapshots: Array<{
            stage: string;
            status: string;
            materializedCollectorSockets: number;
            materializedUserScopedSockets: number;
            openedUserScopedSockets: number;
            openedMachineCollectors: number;
            counts: {
                userDeviceGroups: number;
                userScopedSockets: number;
            };
        }> = [];
        const provisionMachineBoundSessionScopedSocketBinding = vi.fn(async (params) => {
            provisionBindingBaseUrls.push(`${params.baseUrl}:${params.token}:${params.sessionId}`);
            return {
                machineId: `machine-for-${params.sessionId}`,
            };
        });
        const createSessionScopedSocketCollector = vi.fn((baseUrl: string, token: string, sessionId: string) => {
            socketCollectorBaseUrls.push(`${baseUrl}:${token}:${sessionId}`);
            return createMockSocketCollector(`collector:${sessionId}`);
        });
        const createUserScopedSocketCollector = vi.fn((_baseUrl: string, token: string) => {
            userScopedCollectorTokens.push(token);
            return createMockSocketCollector(`user:${token === 'token-a' ? '40' : '41'}`);
        });
        const createMockSocketCollector = (label: string): SocketCollector => ({
            connect: vi.fn(() => {
                connectedEvents.push(label);
            }),
            disconnect: vi.fn(),
            close: vi.fn(),
            isConnected: vi.fn(() => true),
            getEvents: vi.fn(() => []),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            onRpcRequest: vi.fn(),
            rpcRegister: vi.fn(),
            rpcCall: vi.fn(),
        } satisfies Pick<SocketCollector, 'close' | 'connect' | 'disconnect' | 'emit' | 'emitWithAck' | 'getEvents' | 'isConnected' | 'onRpcRequest' | 'rpcCall' | 'rpcRegister'>) as unknown as SocketCollector;

        const result = await runMixedScenarioBootstrap({
            baseUrl: 'http://gateway:8080',
            controlPlaneBaseUrl: 'http://api:53288',
            controlPlaneBaseUrls: ['http://api-1:53288', 'http://api-2:53288'],
            config: {
                ...baseConfig,
                load: {
                    ...baseConfig.load,
                    users: 2,
                    mixedCaptureSocketEvents: false,
                },
            },
            auths: [{ token: 'token-a' }, { token: 'token-b' }],
            authIndexOffset: 40,
            onProgressSnapshot: (snapshot) => {
                bootstrapProgressSnapshots.push({
                    stage: snapshot.stage,
                    status: snapshot.status,
                    materializedCollectorSockets: socketCollectorBaseUrls.length,
                    materializedUserScopedSockets: userScopedCollectorTokens.length,
                    openedUserScopedSockets: snapshot.counts.openedUserScopedSockets,
                    openedMachineCollectors: snapshot.counts.openedMachineCollectors,
                    counts: {
                        userDeviceGroups: snapshot.counts.userDeviceGroups,
                        userScopedSockets: snapshot.counts.userScopedSockets,
                    },
                });
            },
            workload: createWorkload({
                sessionPlans: [
                    { authIndex: 0, sessionSlot: 0 },
                    { authIndex: 1, sessionSlot: 0 },
                ],
                rpcListenerCount: 1,
                rpcReadinessProbeCount: 1,
                messageCount: 0,
                reconnectCycles: 0,
                verificationSessionCount: 2,
                presencePulseCollectorCount: 0,
            }),
        }, {
            createSession: vi.fn(async (baseUrl: string, token: string) => {
                sessionCreateBaseUrls.push(`${baseUrl}:${token}`);
                return { sessionId: `session-for-${token}`, tag: 'tag-1' };
            }),
            provisionMachineBoundSessionScopedSocketBinding,
            createSessionScopedSocketCollector,
            createUserScopedSocketCollector,
            resolveStressSocketTransports: vi.fn(() => ['websocket'] as const),
            runStressTasksWithConcurrencyLimit: vi.fn(async (items, _limit, task) => {
                const results = [];
                for (let index = 0; index < items.length; index += 1) {
                    results.push(await task(items[index], index));
                }
                return results;
            }),
            runStressTaskCountWithConcurrencyLimit: vi.fn(async (count, _limit, task) => {
                const results = [];
                for (let index = 0; index < count; index += 1) {
                    results.push(await task(index));
                }
                return results;
            }),
            resolveMixedConnectConvergenceTimeoutMs: vi.fn(() => 15000),
            runMixedSocketConnectTasks: vi.fn(async (params) => {
                for (const task of params.tasks) {
                    await task();
                }
            }),
            sleep: vi.fn(async () => {}),
            waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
                expect(await predicate()).toBe(true);
            }),
            captureMixedConnectivitySnapshot: vi.fn(({ userDevices, machineCollectors }) => ({
                userDevices: {
                    total: userDevices.length,
                    connected: userDevices.length,
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
                    total: machineCollectors.length,
                    connected: machineCollectors.length,
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
            })),
        });

        expect(sessionCreateBaseUrls).toEqual([
            'http://api-1:53288:token-a',
            'http://api-2:53288:token-b',
        ]);
        expect(provisionBindingBaseUrls).toEqual([
            'http://api-1:53288:token-a:session-for-token-a',
            'http://api-2:53288:token-b:session-for-token-b',
        ]);
        expect(socketCollectorBaseUrls).toEqual([
            'http://api-1:53288:token-a:session-for-token-a',
            'http://api-2:53288:token-b:session-for-token-b',
        ]);
        expect(userScopedCollectorTokens).toEqual(['token-a', 'token-b']);
        expect(result.userDevices.map((entry) => entry.authIndex)).toEqual([40, 41]);
        expect(result.machineCollectors.map((entry) => entry.authIndex)).toEqual([40, 41]);
        expect(result.sessions).toEqual([
            { sessionId: 'session-for-token-a', authIndex: 40 },
            { sessionId: 'session-for-token-b', authIndex: 41 },
        ]);
        expect(Array.from(result.verificationSessionTokensBySessionId.entries())).toEqual([
            ['session-for-token-a', 'token-a'],
            ['session-for-token-b', 'token-b'],
        ]);
        expect(connectedEvents).toEqual([
            'user:40',
            'user:41',
            'collector:session-for-token-a',
            'collector:session-for-token-b',
        ]);
        expect(bootstrapProgressSnapshots).toEqual([
            {
                stage: 'provision',
                status: 'started',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 0,
                    userScopedSockets: 0,
                },
            },
            {
                stage: 'session_create',
                status: 'started',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 0,
                    userScopedSockets: 0,
                },
            },
            {
                stage: 'session_create',
                status: 'completed',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 0,
                    userScopedSockets: 0,
                },
            },
            {
                stage: 'machine_binding',
                status: 'started',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 0,
                    userScopedSockets: 0,
                },
            },
            {
                stage: 'machine_binding',
                status: 'completed',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 0,
                    userScopedSockets: 0,
                },
            },
            {
                stage: 'machine_binding',
                status: 'milestone',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 0,
                    userScopedSockets: 0,
                },
            },
            {
                stage: 'machine_binding',
                status: 'milestone',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 0,
                    userScopedSockets: 0,
                },
            },
            {
                stage: 'provision',
                status: 'completed',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 0,
                    userScopedSockets: 0,
                },
            },
            {
                stage: 'machine_collectors',
                status: 'started',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 0,
                    userScopedSockets: 0,
                },
            },
            {
                stage: 'machine_collectors',
                status: 'completed',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 0,
                    userScopedSockets: 0,
                },
            },
            {
                stage: 'user_devices',
                status: 'started',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 2,
                    userScopedSockets: 2,
                },
            },
            {
                stage: 'user_devices',
                status: 'completed',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 2,
                    userScopedSockets: 2,
                },
            },
            {
                stage: 'connect_user_devices_materialize',
                status: 'started',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 0,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 0,
                    userScopedSockets: 0,
                },
            },
            {
                stage: 'connect_user_devices_open',
                status: 'started',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 1,
                openedUserScopedSockets: 0,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 1,
                    userScopedSockets: 1,
                },
            },
            {
                stage: 'connect_user_devices_materialize',
                status: 'completed',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 2,
                openedUserScopedSockets: 1,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 2,
                    userScopedSockets: 2,
                },
            },
            {
                stage: 'connect_user_devices_open',
                status: 'completed',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 2,
                openedUserScopedSockets: 2,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 2,
                    userScopedSockets: 2,
                },
            },
            {
                stage: 'connect_machine_collectors',
                status: 'started',
                materializedCollectorSockets: 0,
                materializedUserScopedSockets: 2,
                openedUserScopedSockets: 2,
                openedMachineCollectors: 0,
                counts: {
                    userDeviceGroups: 2,
                    userScopedSockets: 2,
                },
            },
            {
                stage: 'connect_machine_collectors',
                status: 'completed',
                materializedCollectorSockets: 2,
                materializedUserScopedSockets: 2,
                openedUserScopedSockets: 2,
                openedMachineCollectors: 2,
                counts: {
                    userDeviceGroups: 2,
                    userScopedSockets: 2,
                },
            },
            {
                stage: 'connect_wait',
                status: 'started',
                materializedCollectorSockets: 2,
                materializedUserScopedSockets: 2,
                openedUserScopedSockets: 2,
                openedMachineCollectors: 2,
                counts: {
                    userDeviceGroups: 2,
                    userScopedSockets: 2,
                },
            },
            {
                stage: 'connect_wait',
                status: 'completed',
                materializedCollectorSockets: 2,
                materializedUserScopedSockets: 2,
                openedUserScopedSockets: 2,
                openedMachineCollectors: 2,
                counts: {
                    userDeviceGroups: 2,
                    userScopedSockets: 2,
                },
            },
        ]);
    });

    it('aggregates provisioning stages reported by session socket binding', async () => {
        const createMockSocketCollector = (): SocketCollector => ({
            connect: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            isConnected: vi.fn(() => true),
            getEvents: vi.fn(() => []),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            onRpcRequest: vi.fn(),
            rpcRegister: vi.fn(),
            rpcCall: vi.fn(),
        } satisfies Pick<SocketCollector, 'close' | 'connect' | 'disconnect' | 'emit' | 'emitWithAck' | 'getEvents' | 'isConnected' | 'onRpcRequest' | 'rpcCall' | 'rpcRegister'>) as unknown as SocketCollector;

        const result = await runMixedScenarioBootstrap({
            baseUrl: 'http://gateway:8080',
            controlPlaneBaseUrl: 'http://api:53288',
            config: baseConfig,
            auths: [{ token: 'token-a' }],
            workload: createWorkload({
                sessionPlans: [{ authIndex: 0, sessionSlot: 0 }],
                rpcListenerCount: 1,
                rpcReadinessProbeCount: 1,
                messageCount: 0,
                reconnectCycles: 0,
                verificationSessionCount: 1,
                presencePulseCollectorCount: 0,
            }),
        }, {
            createSession: vi.fn(async () => ({ sessionId: 'session-1', tag: 'tag-1' })),
            provisionMachineBoundSessionScopedSocketBinding: vi.fn(async (params) => {
                params.onProvisioningStage?.({
                    stage: 'machine_create',
                    result: 'ok',
                    durationMs: 12,
                    status: 200,
                });
                params.onProvisioningStage?.({
                    stage: 'access_key_create',
                    result: 'error',
                    durationMs: 7,
                    status: 500,
                });
                return {
                    machineId: 'machine-1',
                };
            }),
            createSessionScopedSocketCollector: vi.fn(() => createMockSocketCollector()),
            createUserScopedSocketCollector: vi.fn(() => createMockSocketCollector()),
            resolveStressSocketTransports: vi.fn(() => ['websocket'] as const),
            runStressTasksWithConcurrencyLimit: vi.fn(async (items, _limit, task) => {
                const results = [];
                for (let index = 0; index < items.length; index += 1) {
                    results.push(await task(items[index], index));
                }
                return results;
            }),
            runStressTaskCountWithConcurrencyLimit: vi.fn(async (count, _limit, task) => {
                const results = [];
                for (let index = 0; index < count; index += 1) {
                    results.push(await task(index));
                }
                return results;
            }),
            resolveMixedConnectConvergenceTimeoutMs: vi.fn(() => 15000),
            runMixedSocketConnectTasks: vi.fn(async (params) => {
                for (const task of params.tasks) {
                    await task();
                }
            }),
            sleep: vi.fn(async () => {}),
            waitFor: vi.fn(async () => {}),
            captureMixedConnectivitySnapshot: vi.fn(({ userDevices, machineCollectors }) => ({
                userDevices: {
                    total: userDevices.length,
                    connected: userDevices.length,
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
                    total: machineCollectors.length,
                    connected: machineCollectors.length,
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
            })),
        });

        expect(result.provisioningStages).toEqual({
            session_create: { completedCount: 1, failedCount: 0, totalMs: expect.any(Number) },
            machine_create: { completedCount: 1, failedCount: 0, totalMs: 12 },
            access_key_create: { completedCount: 0, failedCount: 1, totalMs: 7 },
        });
        expect(Array.from(result.verificationSessionTokensBySessionId.entries())).toEqual([
            ['session-1', 'token-a'],
        ]);
    });

    it('emits connect_user_devices milestones before large-burst connect completion', async () => {
        const connectMilestones: Array<{
            stage: string;
            status: string;
            openedUserScopedSockets: number;
            counts: {
                userDeviceGroups: number;
                userScopedSockets: number;
            };
        }> = [];

        const createMockSocketCollector = (): SocketCollector => ({
            connect: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            isConnected: vi.fn(() => true),
            getEvents: vi.fn(() => []),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            onRpcRequest: vi.fn(),
            rpcRegister: vi.fn(),
            rpcCall: vi.fn(),
        } satisfies Pick<SocketCollector, 'close' | 'connect' | 'disconnect' | 'emit' | 'emitWithAck' | 'getEvents' | 'isConnected' | 'onRpcRequest' | 'rpcCall' | 'rpcRegister'>) as unknown as SocketCollector;

        await runMixedScenarioBootstrap({
            baseUrl: 'http://gateway:8080',
            controlPlaneBaseUrl: 'http://api:53288',
            config: {
                ...baseConfig,
                load: {
                    ...baseConfig.load,
                    users: 8,
                    mixedCaptureSocketEvents: false,
                },
            },
            auths: Array.from({ length: 8 }, (_, index) => ({ token: `token-${index}` })),
            workload: createWorkload({
                sessionPlans: Array.from({ length: 8 }, (_, authIndex) => ({ authIndex, sessionSlot: 0 })),
                rpcListenerCount: 1,
                rpcReadinessProbeCount: 1,
                messageCount: 0,
                reconnectCycles: 0,
                verificationSessionCount: 1,
                presencePulseCollectorCount: 0,
            }),
            onProgressSnapshot: (snapshot) => {
                if (snapshot.stage.startsWith('connect_')) {
                    connectMilestones.push({
                        stage: snapshot.stage,
                        status: snapshot.status,
                        openedUserScopedSockets: snapshot.counts.openedUserScopedSockets,
                        counts: {
                            userDeviceGroups: snapshot.counts.userDeviceGroups,
                            userScopedSockets: snapshot.counts.userScopedSockets,
                        },
                    });
                }
            },
        }, {
            createSession: vi.fn(async (_baseUrl: string, token: string) => ({
                sessionId: `session-for-${token}`,
                tag: 'tag-1',
            })),
            provisionMachineBoundSessionScopedSocketBinding: vi.fn(async (params) => ({
                machineId: `machine-for-${params.sessionId}`,
            })),
            createSessionScopedSocketCollector: vi.fn(() => createMockSocketCollector()),
            createUserScopedSocketCollector: vi.fn(() => createMockSocketCollector()),
            resolveStressSocketTransports: vi.fn(() => ['websocket'] as const),
            runStressTasksWithConcurrencyLimit: vi.fn(async (items, _limit, task) => {
                const results = [];
                for (let index = 0; index < items.length; index += 1) {
                    results.push(await task(items[index], index));
                }
                return results;
            }),
            runStressTaskCountWithConcurrencyLimit: vi.fn(async (count, _limit, task) => {
                const results = [];
                for (let index = 0; index < count; index += 1) {
                    results.push(await task(index));
                }
                return results;
            }),
            resolveMixedConnectConvergenceTimeoutMs: vi.fn(() => 15000),
            runMixedSocketConnectTasks: vi.fn(async (params) => {
                for (const task of params.tasks) {
                    await task();
                }
            }),
            sleep: vi.fn(async () => {}),
            waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
                expect(await predicate()).toBe(true);
            }),
            captureMixedConnectivitySnapshot: vi.fn(({ userDevices, machineCollectors }) => ({
                userDevices: {
                    total: userDevices.length,
                    connected: userDevices.length,
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
                    total: machineCollectors.length,
                    connected: machineCollectors.length,
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
            })),
        });

        expect(connectMilestones).toEqual(expect.arrayContaining([
            expect.objectContaining({
                stage: 'connect_user_devices_materialize',
                status: 'milestone',
                counts: {
                    userDeviceGroups: 8,
                    userScopedSockets: 8,
                },
            }),
            expect.objectContaining({
                stage: 'connect_user_devices_open',
                status: 'milestone',
                openedUserScopedSockets: 8,
                counts: {
                    userDeviceGroups: 8,
                    userScopedSockets: 8,
                },
            }),
        ]));
    });

    it('preserves opened and connected machine-collector counts when connect_wait fails', async () => {
        const bootstrapSnapshots: Array<{
            stage: string;
            status: string;
            error?: string;
            counts: {
                openedUserScopedSockets: number;
                connectedUserScopedSockets: number;
                openedMachineCollectors: number;
                connectedMachineCollectors: number;
                userDeviceGroups: number;
                machineCollectors: number;
            };
        }> = [];

        const createConnectedUserScopedSocketCollector = (): SocketCollector => ({
            connect: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            isConnected: vi.fn(() => true),
            getEvents: vi.fn(() => []),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            onRpcRequest: vi.fn(),
            rpcRegister: vi.fn(),
            rpcCall: vi.fn(),
        } satisfies Pick<SocketCollector, 'close' | 'connect' | 'disconnect' | 'emit' | 'emitWithAck' | 'getEvents' | 'isConnected' | 'onRpcRequest' | 'rpcCall' | 'rpcRegister'>) as unknown as SocketCollector;

        const createDisconnectedMachineCollector = (): SocketCollector => ({
            connect: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            isConnected: vi.fn(() => false),
            getEvents: vi.fn(() => [{ kind: 'connect_error' as const, at: Date.now(), message: 'still connecting' }]),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            onRpcRequest: vi.fn(),
            rpcRegister: vi.fn(),
            rpcCall: vi.fn(),
        } satisfies Pick<SocketCollector, 'close' | 'connect' | 'disconnect' | 'emit' | 'emitWithAck' | 'getEvents' | 'isConnected' | 'onRpcRequest' | 'rpcCall' | 'rpcRegister'>) as unknown as SocketCollector;

        await expect(runMixedScenarioBootstrap({
            baseUrl: 'http://gateway:8080',
            controlPlaneBaseUrl: 'http://api:53288',
            config: {
                ...baseConfig,
                load: {
                    ...baseConfig.load,
                    users: 1,
                    mixedCaptureSocketEvents: false,
                },
            },
            auths: [{ token: 'token-a' }],
            workload: createWorkload({
                sessionPlans: [{ authIndex: 0, sessionSlot: 0 }],
                rpcListenerCount: 0,
                rpcReadinessProbeCount: 0,
                messageCount: 0,
                reconnectCycles: 0,
                verificationSessionCount: 1,
                presencePulseCollectorCount: 0,
            }),
            onProgressSnapshot: (snapshot) => {
                bootstrapSnapshots.push({
                    stage: snapshot.stage,
                    status: snapshot.status,
                    error: snapshot.error,
                    counts: {
                        openedUserScopedSockets: snapshot.counts.openedUserScopedSockets,
                        connectedUserScopedSockets: snapshot.counts.connectedUserScopedSockets,
                        openedMachineCollectors: snapshot.counts.openedMachineCollectors,
                        connectedMachineCollectors: snapshot.counts.connectedMachineCollectors,
                        userDeviceGroups: snapshot.counts.userDeviceGroups,
                        machineCollectors: snapshot.counts.machineCollectors,
                    },
                });
            },
        }, {
            createSession: vi.fn(async () => ({ sessionId: 'session-1', tag: 'tag-1' })),
            provisionMachineBoundSessionScopedSocketBinding: vi.fn(async () => ({
                machineId: 'machine-1',
            })),
            createSessionScopedSocketCollector: vi.fn(() => createDisconnectedMachineCollector()),
            createUserScopedSocketCollector: vi.fn(() => createConnectedUserScopedSocketCollector()),
            resolveStressSocketTransports: vi.fn(() => ['websocket'] as const),
            runStressTasksWithConcurrencyLimit: vi.fn(async (items, _limit, task) => {
                const results = [];
                for (let index = 0; index < items.length; index += 1) {
                    results.push(await task(items[index], index));
                }
                return results;
            }),
            runStressTaskCountWithConcurrencyLimit: vi.fn(async (count, _limit, task) => {
                const results = [];
                for (let index = 0; index < count; index += 1) {
                    results.push(await task(index));
                }
                return results;
            }),
            resolveMixedConnectConvergenceTimeoutMs: vi.fn(() => 1234),
            runMixedSocketConnectTasks: vi.fn(async (params) => {
                for (const task of params.tasks) {
                    await task();
                }
            }),
            sleep: vi.fn(async () => {}),
            waitFor: vi.fn(async () => {
                throw new Error('Timed out waiting for condition');
            }),
            captureMixedConnectivitySnapshot: vi.fn(({ userDevices, machineCollectors }) => ({
                userDevices: {
                    total: userDevices.length,
                    connected: userDevices.length,
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
                    total: machineCollectors.length,
                    connected: 0,
                    disconnectedCount: machineCollectors.length,
                    disconnectedAuthIndexes: [],
                    eventSummary: {
                        lastConnectErrorMessageCounts: {},
                        lastDisconnectReasonCounts: {},
                        missingLastConnectErrorCount: 0,
                        missingLastDisconnectCount: 0,
                    },
                    disconnectedSample: [],
                },
            })),
        })).rejects.toThrow('Timed out waiting for condition');

        expect(bootstrapSnapshots).toEqual(expect.arrayContaining([
            expect.objectContaining({
                stage: 'connect_wait',
                status: 'failed',
                error: 'Timed out waiting for condition',
                counts: {
                    openedUserScopedSockets: 1,
                    connectedUserScopedSockets: 1,
                    openedMachineCollectors: 1,
                    connectedMachineCollectors: 0,
                    userDeviceGroups: 1,
                    machineCollectors: 1,
                },
            }),
        ]));
    });
});
