import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    authBaseUrls: [] as string[],
    sessionCreates: [] as Array<{ baseUrl: string; token: string }>,
    failSessionCreateAt: undefined as number | undefined,
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
        emitWithAck: vi.fn(),
        onRpcRequest: vi.fn(),
        rpcRegister: vi.fn(),
        rpcCall: vi.fn(),
        off: vi.fn(),
        on: vi.fn(),
    };
}

vi.mock('../../socketClient', () => ({
    createUserScopedSocketCollector: vi.fn((_baseUrl: string, token: string) => createMockSocketCollector(`user:${token}`)),
}));

vi.mock('../../sessionSocketBinding', () => ({
    createMachineBoundSessionScopedSocketCollector: vi.fn(async (params: { token: string; sessionId: string }) => ({
        machineId: `machine:${params.sessionId}`,
        socket: createMockSocketCollector(`collector:${params.token}:${params.sessionId}`),
    })),
}));

vi.mock('../../sessions', () => ({
    createSession: vi.fn(async (baseUrl: string, token: string) => {
        state.sessionCreates.push({ baseUrl, token });
        const invocation = state.sessionCreates.length;
        if (state.failSessionCreateAt === invocation) {
            throw new Error(`session create failed at ${invocation}`);
        }
        return {
            sessionId: `session-${invocation}`,
        };
    }),
}));

vi.mock('../../timing', () => ({
    sleep: vi.fn(async () => {}),
    waitFor: vi.fn(async (predicate: () => boolean | Promise<boolean>) => {
        expect(await predicate()).toBe(true);
    }),
}));

describe('runMixedConnectCeilingShardWork', () => {
    beforeEach(() => {
        state.authBaseUrls = [];
        state.sessionCreates = [];
        state.failSessionCreateAt = undefined;
        vi.resetModules();
    });

    it('reports progress snapshots from the real shard worker before returning the final result', async () => {
        const { runMixedConnectCeilingShardWork } = await import('./runMixedConnectCeilingShardWork');
        const snapshots: Array<{ phase: string; connectedMachineCollectors: number }> = [];

        const result = await runMixedConnectCeilingShardWork({
            baseUrl: 'http://gateway:8080',
            controlPlaneBaseUrl: 'http://api:53288',
            authIndexStart: 10,
            shardIndex: 2,
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
                    rpcCallsPerSecond: 0,
                    messagesPerSecond: 0,
                    reconnectRate: 0,
                    mixedSessionMode: 'representative',
                    mixedSetupConcurrency: 2,
                    mixedConnectConcurrency: 2,
                    mixedMessageEmitterCount: 1,
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
            onProgress: (snapshot) => {
                snapshots.push({
                    phase: snapshot.phase,
                    connectedMachineCollectors: snapshot.connectedMachineCollectors,
                });
            },
        });

        expect(snapshots).toEqual([
            { phase: 'provision', connectedMachineCollectors: 0 },
            { phase: 'complete', connectedMachineCollectors: 2 },
        ]);
        expect(result).toEqual(expect.objectContaining({
            shardIndex: 2,
            authIndexStart: 10,
            authIndexEndExclusive: 12,
            connectedUserDevices: 2,
            connectedMachineCollectors: 2,
        }));
    }, 10_000);

    it('attaches a partialResult snapshot when setup fails after auth succeeds', async () => {
        const sessionsModule = await import('../../sessions');
        vi.mocked(sessionsModule.createSession)
            .mockImplementationOnce(async () => ({ sessionId: 'session-1', tag: 'tag-1' }))
            .mockImplementationOnce(async () => {
                throw new Error('session create failed at 2');
            });
        const { runMixedConnectCeilingShardWork } = await import('./runMixedConnectCeilingShardWork');

        let failure: unknown;
        try {
            await runMixedConnectCeilingShardWork({
                baseUrl: 'http://gateway:8080',
                controlPlaneBaseUrl: 'http://api:53288',
                authIndexStart: 3,
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
                        rpcCallsPerSecond: 0,
                        messagesPerSecond: 0,
                        reconnectRate: 0,
                        mixedSessionMode: 'representative',
                        mixedSetupConcurrency: 1,
                        mixedConnectConcurrency: 2,
                        mixedMessageEmitterCount: 1,
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
        expect((failure as Error).message).toContain('Mixed connect ceiling shard failed for authIndexStart=3');
        expect((failure as Error & { partialResult?: unknown }).partialResult).toEqual(expect.objectContaining({
            authIndexStart: 3,
            shardIndex: 1,
            authIndexEndExclusive: 5,
            connectedMachineCollectors: 0,
            machineCollectorsTotal: 1,
            phase: 'failed',
        }));
    }, 10_000);
});
