import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    authBaseUrls: [] as string[],
    sessionCreateBaseUrls: [] as string[],
    sessionBindings: [] as string[],
    failBindingAt: undefined as number | undefined,
}));

vi.mock('../../auth', () => ({
    createTestAuth: vi.fn(async (baseUrl: string) => {
        state.authBaseUrls.push(baseUrl);
        return {
            token: `token-${state.authBaseUrls.length}`,
        };
    }),
}));

function createMockSocketCollector(label: string) {
    let connected = false;
    const rpcHandlers = new Map<string, string>();
    return {
        label,
        connect: vi.fn(() => {
            connected = true;
        }),
        disconnect: vi.fn(() => {
            connected = false;
        }),
        close: vi.fn(() => {
            connected = false;
        }),
        isConnected: vi.fn(() => connected),
        getEvents: vi.fn(() => []),
        getConnectivityState: vi.fn(() => undefined),
        emit: vi.fn(),
        emitWithAck: vi.fn(async (_event: string, payload: { localId: string }) => ({
            ok: true,
            localId: payload.localId,
        })),
        onRpcRequest: vi.fn(),
        rpcRegister: vi.fn(async (method: string) => {
            rpcHandlers.set(method, label);
        }),
        rpcCall: vi.fn(async (method: string) => {
            const machineId = rpcHandlers.get(method);
            if (!machineId) {
                return {
                    ok: false,
                    errorCode: 'RPC_METHOD_NOT_AVAILABLE',
                };
            }
            return {
                ok: true,
                result: JSON.stringify({
                    ok: true,
                    machineId,
                }),
            };
        }),
        off: vi.fn(),
        on: vi.fn(),
    };
}

vi.mock('../../socketClient', () => ({
    createSessionScopedSocketCollector: vi.fn((_baseUrl: string, _token: string, _sessionId: string, machineId: string) =>
        createMockSocketCollector(machineId)),
    createUserScopedSocketCollector: vi.fn((_baseUrl: string, token: string) =>
        createMockSocketCollector(`user:${token}`)),
}));

vi.mock('../../sessionSocketBinding', () => ({
    provisionMachineBoundSessionScopedSocketBinding: vi.fn(async (params: { token: string; sessionId: string }) => {
        state.sessionBindings.push(`${params.token}:${params.sessionId}`);
        const invocation = state.sessionBindings.length;
        if (state.failBindingAt === invocation) {
            throw new Error(`binding failed at ${invocation}`);
        }
        return {
            machineId: `machine-${invocation}`,
        };
    }),
}));

vi.mock('../../sessions', () => ({
    createSession: vi.fn(async (baseUrl: string) => {
        state.sessionCreateBaseUrls.push(baseUrl);
        return {
            sessionId: `session-${state.sessionCreateBaseUrls.length}`,
        };
    }),
    fetchAllMessages: vi.fn(async () => []),
    countDuplicateLocalIds: vi.fn(() => 0),
}));

vi.mock('../../timing', () => ({
    sleep: vi.fn(async () => {}),
    waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
        expect(await predicate()).toBe(true);
    }),
}));

describe('runMixedRealisticShardWork', () => {
    beforeEach(() => {
        state.authBaseUrls = [];
        state.sessionCreateBaseUrls = [];
        state.sessionBindings = [];
        state.failBindingAt = undefined;
        vi.resetModules();
    });

    it('runs the real bootstrap and traffic path with only boundary fakes, preserving shard progress and control-plane auth distribution', async () => {
        const { runMixedRealisticShardWork } = await import('./runMixedRealisticShardWork');
        const progressSnapshots: Array<{ phase: string; status: string; subphase?: string }> = [];

        const result = await runMixedRealisticShardWork({
            baseUrl: 'http://gateway:8080',
            controlPlaneBaseUrl: 'http://api:53288',
            controlPlaneBaseUrls: ['http://api-1:53288', 'http://api-2:53288'],
            authIndexStart: 0,
            shardIndex: 0,
            config: {
                targetMode: 'full-compose',
                baseUrl: undefined,
                repeat: 1,
                seed: 42,
                flakeRetry: false,
                socketTransport: 'websocket',
                duration: {
                    warmupMs: 0,
                    durationMs: 1_000,
                    cooldownMs: 0,
                    soakMs: 0,
                },
                load: {
                    users: 3,
                    machinesPerUser: 1,
                    sessionsPerUser: 1,
                    rpcListenersPerUser: 1,
                    rpcCallsPerSecond: 10,
                    messagesPerSecond: 10,
                    reconnectRate: 1,
                    mixedSessionMode: 'representative',
                    mixedSetupConcurrency: 2,
                    mixedConnectConcurrency: 2,
                    mixedActiveSessionPercent: 0,
                    mixedStreamingSegmentsPerSecond: 0,
                },
                orchestration: {
                    rollingRestartEnabled: false,
                    killTarget: 'none',
                    expectedApiReplicas: 1,
                    expectedWorkerReplicas: 1,
                },
                compose: {
                    apiReplicas: 1,
                    workerReplicas: 1,
                    imageBuildStrategy: 'never',
                    reuseRunningTopology: false,
                    frontDoorMode: 'gateway',
                    loadGenerationMode: 'compose-network',
                    metricsEnabled: false,
                    filesBackend: 's3',
                },
                artifacts: {
                    saveArtifactsOnSuccess: false,
                    metricsScrapeEnabled: false,
                    keepTopologyOnFailure: false,
                },
            },
            onProgressSnapshot: (snapshot) => {
                progressSnapshots.push({
                    phase: snapshot.phase,
                    status: snapshot.status,
                    ...(snapshot.subphase ? { subphase: snapshot.subphase } : {}),
                });
            },
        });

        expect(state.authBaseUrls).toEqual([
            'http://api-1:53288',
            'http://api-2:53288',
            'http://api-1:53288',
        ]);
        expect([...state.sessionCreateBaseUrls].sort()).toEqual([
            'http://api-1:53288',
            'http://api-1:53288',
            'http://api-2:53288',
        ]);
        expect(result).toEqual(expect.objectContaining({
            shardIndex: 0,
            authIndexEndExclusive: 3,
            counts: expect.objectContaining({
                sessions: 3,
                activeSessions: 0,
                machineSockets: 3,
                messagesSent: 0,
                rpcCalls: 0,
            }),
            rpcReadiness: {
                probed: 0,
                successful: 0,
                failed: 0,
                ledger: [],
            },
        }));
        expect(progressSnapshots).toEqual(expect.arrayContaining([
            { phase: 'auth', status: 'completed' },
            { phase: 'bootstrap', status: 'started' },
            { phase: 'bootstrap', status: 'completed' },
            { phase: 'traffic', status: 'started' },
            { phase: 'traffic', status: 'completed' },
        ]));
    }, 10_000);

    it('returns a partial shard result when the real bootstrap path fails', async () => {
        const sessionSocketBindingModule = await import('../../sessionSocketBinding');
        vi.mocked(sessionSocketBindingModule.provisionMachineBoundSessionScopedSocketBinding)
            .mockImplementationOnce(async () => ({ machineId: 'machine-1' }))
            .mockImplementationOnce(async () => {
                throw new Error('binding failed at 2');
            });
        const { runMixedRealisticShardWork } = await import('./runMixedRealisticShardWork');

        let failure: unknown;
        try {
            await runMixedRealisticShardWork({
                baseUrl: 'http://gateway:8080',
                controlPlaneBaseUrl: 'http://api:53288',
                authIndexStart: 5,
                shardIndex: 1,
                config: {
                    targetMode: 'full-compose',
                    baseUrl: undefined,
                    repeat: 1,
                    seed: 42,
                    flakeRetry: false,
                    socketTransport: 'websocket',
                    duration: {
                        warmupMs: 0,
                        durationMs: 1_000,
                        cooldownMs: 0,
                        soakMs: 0,
                    },
                    load: {
                        users: 2,
                        machinesPerUser: 1,
                        sessionsPerUser: 1,
                        rpcListenersPerUser: 1,
                        rpcCallsPerSecond: 10,
                        messagesPerSecond: 10,
                        reconnectRate: 1,
                        mixedSessionMode: 'representative',
                        mixedSetupConcurrency: 1,
                        mixedConnectConcurrency: 2,
                        mixedActiveSessionPercent: 0,
                        mixedStreamingSegmentsPerSecond: 0,
                    },
                    orchestration: {
                        rollingRestartEnabled: false,
                        killTarget: 'none',
                        expectedApiReplicas: 1,
                        expectedWorkerReplicas: 1,
                    },
                    compose: {
                        apiReplicas: 1,
                        workerReplicas: 1,
                        imageBuildStrategy: 'never',
                        reuseRunningTopology: false,
                        frontDoorMode: 'gateway',
                        metricsEnabled: false,
                        filesBackend: 's3',
                    },
                    artifacts: {
                        saveArtifactsOnSuccess: false,
                        metricsScrapeEnabled: false,
                        keepTopologyOnFailure: false,
                    },
                },
            });
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain('Mixed realistic shard failed for authIndexStart=5');
        expect((failure as Error & { partialResult?: unknown }).partialResult).toEqual(expect.objectContaining({
            authIndexStart: 5,
            shardIndex: 1,
            counts: expect.objectContaining({
                sessions: 1,
                activeSessions: 0,
                machineSockets: 0,
            }),
            progressSnapshots: expect.arrayContaining([
                expect.objectContaining({
                    phase: 'auth',
                    status: 'completed',
                }),
                expect.objectContaining({
                    phase: 'bootstrap',
                    status: 'failed',
                }),
            ]),
        }));
    }, 10_000);
});
