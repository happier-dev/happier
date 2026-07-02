import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveCliEngineRegistry } from './engineRegistry';
import { bindPluginDaemonConnectionStateSource } from './pluginConnectionStateSource';

const {
    resolveMergedContributionRegistryMock,
    resolveExecutablePluginRuntimeRegistryMock,
    resolvePluginBackendSurfaceHandlersMock,
    pluginReloadControllerStateMock,
} = vi.hoisted(() => ({
    resolveMergedContributionRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolveExecutablePluginRuntimeRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolvePluginBackendSurfaceHandlersMock: vi.fn<(...args: unknown[]) => unknown>(),
    pluginReloadControllerStateMock: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('../../../plugins/projection/registry/createResolvedContributionRegistry', () => ({
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
}));

vi.mock('../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
    resolveExecutablePluginRuntimeRegistry: resolveExecutablePluginRuntimeRegistryMock,
}));

vi.mock('../../../plugins/runtime/reload/singleton', () => ({
    pluginReloadController: {
        getState: pluginReloadControllerStateMock,
    },
}));

vi.mock('./resolvePluginBackendSurfaceHandlers', () => ({
    resolvePluginBackendSurfaceHandlers: resolvePluginBackendSurfaceHandlersMock,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

type ConnectionPhaseV1 =
    | 'idle'
    | 'connecting'
    | 'online'
    | 'offline'
    | 'auth_failed'
    | 'shutting_down';

type ConnectionStateV1 = Readonly<{
    phase: ConnectionPhaseV1;
    reason: string | null;
    attempt: number;
    nextRetryAt: number | null;
    lastConnectedAt: number | null;
    lastDisconnectedAt: number | null;
    lastErrorMessage: string | null;
}>;

type ConnectionStateSourceForTest = Readonly<{
    onConnectionStateChange(listener: (state: ConnectionStateV1) => void): () => void;
}>;

type PluginConnectionContextForTest = Readonly<{
    connection?: Readonly<{
        getDaemonLinkState: () => ConnectionStateV1;
        watchDaemonLink: (listener: (state: ConnectionStateV1) => void) => Readonly<{ unsubscribe: () => void }>;
        isDaemonOnline: () => boolean;
        supervise?: unknown;
        connect?: unknown;
        disconnect?: unknown;
        send?: unknown;
        request?: unknown;
    }>;
}>;

const IDLE_CONNECTION_STATE: ConnectionStateV1 = Object.freeze({
    phase: 'idle',
    reason: null,
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastErrorMessage: null,
});

function createConnectionStateSource(initialState: ConnectionStateV1): Readonly<{
    source: ConnectionStateSourceForTest;
    emit: (state: ConnectionStateV1) => void;
    listenerCount: () => number;
}> {
    let currentState = initialState;
    const listeners = new Set<(state: ConnectionStateV1) => void>();
    return {
        source: {
            onConnectionStateChange(listener) {
                listeners.add(listener);
                listener(currentState);
                return () => {
                    listeners.delete(listener);
                };
            },
        },
        emit(state) {
            currentState = state;
            for (const listener of [...listeners]) {
                listener(state);
            }
        },
        listenerCount() {
            return listeners.size;
        },
    };
}

function createPluginContributions() {
    const backend = {
        id: 'acme.sample.backend',
        providerId: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        definition: {
            kindVersion: 1,
            id: 'acme.sample.backend',
            providerId: 'acme.sample.provider',
        },
        richDefinition: {
            source: 'plugin',
            definition: {
                kindVersion: 1,
                id: 'acme.sample.backend',
                providerId: 'acme.sample.provider',
                runtimeKind: 'native',
                capabilities: {},
                surfaceHandlers: [],
            },
        },
        runtimeKind: 'native',
        surfaceHandlers: [],
        pluginId: 'acme.sample',
        daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
    };
    const provider = {
        id: 'acme.sample.provider',
        provenance: 'external',
        source: { kind: 'path' },
        definition: {
            kindVersion: 1,
            id: 'acme.sample.provider',
            ownedBackendIds: ['acme.sample.backend'],
        },
        richDefinition: {
            source: 'plugin',
            definition: {
                kindVersion: 1,
                id: 'acme.sample.provider',
                ownedBackendIds: ['acme.sample.backend'],
            },
        },
        runtimeSpec: null,
        pluginId: 'acme.sample',
        daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
    };
    return {
        providers: [provider],
        backends: [backend],
        actions: [],
        hookRegistrations: [],
        surfaceHandlersByBackendId: new Map(),
        catalogEntriesById: {},
        backendDefinitionsById: new Map([['acme.sample.backend', backend]]),
        providerDefinitionsById: new Map([['acme.sample.provider', provider]]),
        pluginDiagnosticsByPluginId: {},
    };
}

async function capturePluginContext(params?: Parameters<typeof resolveCliEngineRegistry>[0]): Promise<PluginConnectionContextForTest> {
    const contributions = createPluginContributions();
    let observedContext: PluginConnectionContextForTest | null = null;

    resolveMergedContributionRegistryMock.mockResolvedValue(contributions);
    resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
        surfaces: {
            terminalRuntime: null,
            externalSession: null,
            attach: null,
            handoff: null,
            fork: null,
            checkpoint: null,
        },
        diagnostics: [],
    });
    resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
        contributes: contributions,
        actionHandlersByActionId: new Map(),
        hookHandlersByHookId: new Map(),
        runtimeCoreHandlersByBackendId: new Map(),
        backendEnginesByBackendId: new Map([
            ['acme.sample.backend', {
                pluginId: 'acme.sample',
                registration: {
                    backendId: 'acme.sample.backend',
                    create: (ctx: PluginConnectionContextForTest) => {
                        observedContext = ctx;
                        return {
                            runtimeCore: {
                                createSessionRuntime: async () => null,
                                createExecutionRunBackend: () => ({
                                    provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                    readResumeSupport: vi.fn(async () => false),
                                    sendPrompt: vi.fn(async () => undefined),
                                    cancel: vi.fn(async () => undefined),
                                    subscribeMessages: vi.fn(() => () => undefined),
                                    dispose: vi.fn(async () => undefined),
                                }),
                            },
                        };
                    },
                },
            }],
        ]),
        pluginDiagnosticsByPluginId: {},
        readHookEventEnvelopeV1: vi.fn(),
        dispose: vi.fn(async () => undefined),
    });

    const registry = await resolveCliEngineRegistry(params);
    const resolution = await registry.resolveForBackendId('acme.sample.backend');
    expect(resolution?.backendId).toBe('acme.sample.backend');
    expect(observedContext).not.toBeNull();
    return observedContext!;
}

describe('PluginContextV1 connection service', () => {
    let cleanupActiveSource: (() => void) | null = null;

    beforeEach(() => {
        resolveMergedContributionRegistryMock.mockReset();
        resolveExecutablePluginRuntimeRegistryMock.mockReset();
        resolvePluginBackendSurfaceHandlersMock.mockReset();
        pluginReloadControllerStateMock.mockReset();
        pluginReloadControllerStateMock.mockReturnValue({
            generation: 0,
            activeRegistry: null,
            lastResult: null,
        });
    });

    afterEach(() => {
        cleanupActiveSource?.();
        cleanupActiveSource = null;
    });

    it('exposes an observe-only idle daemon-link connection service when no host source is bound', async () => {
        const context = await capturePluginContext();
        const connection = context.connection;

        expect(connection?.getDaemonLinkState).toEqual(expect.any(Function));
        expect(connection?.watchDaemonLink).toEqual(expect.any(Function));
        expect(connection?.isDaemonOnline).toEqual(expect.any(Function));
        expect(connection?.supervise).toBeUndefined();
        expect(connection?.connect).toBeUndefined();
        expect(connection?.disconnect).toBeUndefined();
        expect(connection?.send).toBeUndefined();
        expect(connection?.request).toBeUndefined();
        expect(connection?.getDaemonLinkState()).toEqual(IDLE_CONNECTION_STATE);
        expect(connection?.isDaemonOnline()).toBe(false);

        const observed: ConnectionStateV1[] = [];
        const subscription = connection!.watchDaemonLink((state) => {
            observed.push(state);
        });
        expect(observed).toEqual([IDLE_CONNECTION_STATE]);
        subscription.unsubscribe();
        expect(() => subscription.unsubscribe()).not.toThrow();
    });

    it('projects injected daemon-link state, isolates listener failures, and unsubscribes idempotently', async () => {
        const initialState: ConnectionStateV1 = Object.freeze({
            phase: 'connecting',
            reason: 'initial_connect',
            attempt: 2,
            nextRetryAt: 1000,
            lastConnectedAt: null,
            lastDisconnectedAt: 500,
            lastErrorMessage: 'warming up',
        });
        const onlineState: ConnectionStateV1 = Object.freeze({
            phase: 'online',
            reason: null,
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: 2000,
            lastDisconnectedAt: 500,
            lastErrorMessage: null,
        });
        const offlineState: ConnectionStateV1 = Object.freeze({
            ...onlineState,
            phase: 'offline',
            reason: 'server_unreachable',
            lastDisconnectedAt: 3000,
        });
        const source = createConnectionStateSource(initialState);
        const params = {
            connectionStateSource: source.source,
        } satisfies NonNullable<Parameters<typeof resolveCliEngineRegistry>[0]>;
        const context = await capturePluginContext(params);
        const connection = context.connection!;

        expect(connection.getDaemonLinkState()).toEqual(initialState);
        expect(Object.isFrozen(connection.getDaemonLinkState())).toBe(true);
        expect(connection.isDaemonOnline()).toBe(false);

        const observed: ConnectionStateV1[] = [];
        const subscription = connection.watchDaemonLink((state) => {
            observed.push(state);
            if (state.phase === 'online') {
                throw new Error('listener failure should be isolated');
            }
        });

        expect(observed).toEqual([initialState]);
        expect(source.listenerCount()).toBe(1);
        expect(() => source.emit(onlineState)).not.toThrow();
        expect(connection.getDaemonLinkState()).toEqual(onlineState);
        expect(connection.isDaemonOnline()).toBe(true);
        expect(observed).toEqual([initialState, onlineState]);

        subscription.unsubscribe();
        subscription.unsubscribe();
        expect(source.listenerCount()).toBe(0);
        source.emit(offlineState);
        expect(observed).toEqual([initialState, onlineState]);
    });

    it('uses the active host daemon-link source when no packet-local source is passed', async () => {
        const onlineState: ConnectionStateV1 = Object.freeze({
            phase: 'online',
            reason: null,
            attempt: 0,
            nextRetryAt: null,
            lastConnectedAt: 7000,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        });
        const source = createConnectionStateSource(onlineState);
        cleanupActiveSource = bindPluginDaemonConnectionStateSource(source.source);

        const context = await capturePluginContext();
        const connection = context.connection!;

        expect(connection.getDaemonLinkState()).toEqual(onlineState);
        expect(connection.isDaemonOnline()).toBe(true);
    });
});
