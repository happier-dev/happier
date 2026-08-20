import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import type { initializeRuntimeOverridesSynchronizer as initializeRuntimeOverridesSynchronizerFn } from '@/agent/runtime/runtimeOverridesSynchronizer';
import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';
import { createPermissionHandlerSessionStub } from '@/backends/claude/utils/permissionHandler.testkit';

const agentStateUpdateSnapshots = vi.hoisted(() => [] as Array<{
    reason: string;
    state: any;
}>);

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

type RuntimeOverridesSynchronizer = Awaited<ReturnType<typeof initializeRuntimeOverridesSynchronizerFn>>;
type RuntimeOverridesSynchronizerParams = Parameters<typeof initializeRuntimeOverridesSynchronizerFn>[0];
type StartupSessionResponse = { id: string; metadataVersion: number } | null;

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

function createDeferred<T>(): Deferred<T> {
    let resolveFn: ((value: T) => void) | null = null;
    const promise = new Promise<T>((resolve) => {
        resolveFn = resolve;
    });
    return {
        promise,
        resolve: (value: T) => resolveFn?.(value),
    };
}

const stopAfterSeed = new Error('stop-after-seed');
const stopAfterStartupCoordinator = new Error('stop-after-startup-coordinator');
const testCredentials: Credentials = {
    token: 'test',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

let metadataUpdateDeferred: Deferred<void>;
let currentMetadataVersion = 1;
const getOrCreateSessionMock = vi.fn<() => Promise<StartupSessionResponse>>(async () => ({
    id: 'session-start',
    metadataVersion: currentMetadataVersion,
}));
let lastSessionClient: {
    onUserMessage: ReturnType<typeof vi.fn>;
    sendSessionEvent: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
} | null = null;
const runtimeActivityPublisherCloseMock = vi.fn(async () => {});
const sessionCloseMock = vi.fn(async () => {});

function createRuntimeOverridesSynchronizer(
    overrides: Partial<RuntimeOverridesSynchronizer> = {},
): RuntimeOverridesSynchronizer {
    return {
        seedFromSession: async (): Promise<void> => {
            throw stopAfterSeed;
        },
        syncFromMetadata: vi.fn(),
        getSnapshot: () => ({
            permissionMode: { current: 'default', updatedAt: 0 },
            modelOverride: { current: null, updatedAt: 0 },
        }),
        ...overrides,
    };
}

const applyStartupMetadataUpdateToSessionMock = vi.fn(() => metadataUpdateDeferred.promise);
const createSessionMetadataMock = vi.fn(() => ({
    state: { controlledByUser: false },
    metadata: { path: '/tmp/project', terminal: null },
}));
let lastRuntimeOverridesSynchronizerParams: RuntimeOverridesSynchronizerParams | null = null;
const initializeRuntimeOverridesSynchronizerMock = vi.fn(async (params: RuntimeOverridesSynchronizerParams) => {
    lastRuntimeOverridesSynchronizerParams = params;
    return createRuntimeOverridesSynchronizer();
});
const runStartupCoordinatorMock = vi.fn(() => {
    throw new Error('fast-start coordinator should not run');
});
const claudeLocalMock = vi.fn(async () => undefined);
let lastResolveRunnerMcpServersParams: any = null;
const probeClaudeInstalledRuntimeCapabilitiesMock = vi.fn(async () => ({
    supportsEffort: true,
    supportsUltracode: true,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        infoDeveloper: vi.fn(),
        warn: vi.fn(),
        logFilePath: '/tmp/happier.log',
    },
}));

vi.mock('@/ui/doctor', () => ({
    getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/api/offline/serverConnectionErrors', () => ({
    connectionState: { setBackend: vi.fn(), notifyOffline: vi.fn() },
    startOfflineReconnection: vi.fn(() => ({ cancel: vi.fn() })),
}));

vi.mock('@/agent/runtime/initializeBackendApiContext', () => ({
    initializeBackendApiContext: vi.fn(async () => ({
        api: {
            getOrCreateSession: getOrCreateSessionMock,
            sessionSyncClient: vi.fn(() => {
                lastSessionClient = {
                    onUserMessage: vi.fn(),
                    sendSessionEvent: vi.fn(),
                    close: sessionCloseMock,
                };
                return {
                sessionId: 'session-start',
                rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn() },
                ensureMetadataSnapshot: vi.fn(async () => ({ path: '/srv/project' })),
                getMetadataSnapshot: vi.fn(() => ({ path: '/srv/project' })),
                onUserMessage: lastSessionClient.onUserMessage,
                sendSessionEvent: lastSessionClient.sendSessionEvent,
                updateMetadata: vi.fn(),
                updateAgentState: vi.fn(),
                getRuntimeActivitySnapshotPublisher: vi.fn(() => ({
                    publish: vi.fn(async () => {}),
                    flush: vi.fn(async () => {}),
                    close: runtimeActivityPublisherCloseMock,
                })),
                sendSessionDeath: vi.fn(),
                flush: vi.fn(async () => {}),
                closeProviderInputAdmissionAndWaitForDispatches: vi.fn(async () => {}),
                drainCriticalMetadataWrites: vi.fn(async () => {}),
                cleanup: vi.fn(),
                wasUserAbortRequestedRecently: vi.fn(() => false),
                close: lastSessionClient.close,
            };
            }),
            push: vi.fn(() => ({ sendToAllDevices: vi.fn() })),
        },
        machineId: 'machine_1',
    })),
}));

vi.mock('@/agent/runtime/createSessionMetadata', () => ({
    createSessionMetadata: createSessionMetadataMock,
}));

vi.mock('@/agent/runtime/createBaseSessionForAttach', () => ({
    createBaseSessionForAttach: vi.fn(async () => ({
        id: 'session-attach',
        metadataVersion: currentMetadataVersion,
    })),
}));

vi.mock('@/agent/runtime/startupMetadataUpdate', () => ({
    applyStartupMetadataUpdateToSession: applyStartupMetadataUpdateToSessionMock,
    buildModelOverride: vi.fn(() => null),
    buildPermissionModeOverride: vi.fn(() => null),
}));

vi.mock('@/agent/runtime/runtimeOverridesSynchronizer', () => ({
    initializeRuntimeOverridesSynchronizer: initializeRuntimeOverridesSynchronizerMock,
}));

vi.mock('@/agent/runtime/startupSideEffects', () => ({
    persistTerminalAttachmentInfoIfNeeded: vi.fn(async () => {}),
    reportSessionToDaemonIfRunning: vi.fn(async () => {}),
    sendTerminalFallbackMessageIfNeeded: vi.fn(),
}));

vi.mock('@/agent/runtime/startup/startupCoordinator', () => ({
    runStartupCoordinator: runStartupCoordinatorMock,
}));

vi.mock('@/backends/claude/utils/startHookServer', () => ({
    startHookServer: vi.fn(async () => ({ port: 12345, stop: vi.fn() })),
}));

vi.mock('@/backends/claude/utils/generateHookSettingsFileWithEnsuredRuntime', () => ({
    generateHookPluginDirWithEnsuredRuntime: vi.fn(async () => '/tmp/happier-hook-plugin'),
    generateHookSettingsFileWithEnsuredRuntime: vi.fn(async () => '/tmp/happier-hook-settings.json'),
}));

vi.mock('@/backends/claude/utils/generateHookSettings', () => ({
    cleanupHookPluginDir: vi.fn(),
    cleanupHookSettingsFile: vi.fn(),
}));

vi.mock('@/rpc/handlers/killSession', () => ({
    registerKillSessionHandler: vi.fn(),
}));

vi.mock('@/api/session/sessionWritesBestEffort', () => ({
    updateAgentStateBestEffort: vi.fn((_session, updater, _logPrefix, reason) => {
        agentStateUpdateSnapshots.push({ reason, state: updater({}) });
    }),
    updateMetadataBestEffort: vi.fn(),
}));

vi.mock('@/settings/permissions/permissionModeSeed', () => ({
    resolvePermissionModeSeedForAgentStart: vi.fn(() => ({ mode: 'default' })),
}));

vi.mock('./sessionCaffeinatePolicy', () => ({
    shouldStartClaudeSessionCaffeinate: vi.fn(() => false),
}));

vi.mock('@/integrations/caffeinate', () => ({
    startCaffeinate: vi.fn(() => false),
    stopCaffeinate: vi.fn(),
}));

vi.mock('@/agent/prompting/coding/resolveEffectiveCodingPrompt', () => ({
    resolveEffectiveCodingPromptText: vi.fn(async () => ''),
}));

vi.mock('@/features/featureDecisionService', () => ({
    resolveCliFeatureDecision: vi.fn(() => ({ state: 'disabled' })),
}));

vi.mock('@/backends/claude/sdk/metadataExtractor', () => ({
    extractSDKMetadataAsync: vi.fn(),
}));

vi.mock('@/backends/claude/sessionControls/probeClaudeInstalledRuntimeCapabilities', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/backends/claude/sessionControls/probeClaudeInstalledRuntimeCapabilities')>();
    return {
        ...actual,
        probeClaudeInstalledRuntimeCapabilities: probeClaudeInstalledRuntimeCapabilitiesMock,
    };
});

vi.mock('@/agent/runtime/runnerTerminationOutcome', () => ({
    computeRunnerTerminationOutcome: vi.fn(() => ({ exitCode: 0, terminationReason: 'Exited normally' })),
}));

vi.mock('@/agent/runtime/runnerTerminationHandlers', () => ({
    registerRunnerTerminationHandlers: vi.fn(() => ({
        requestTermination: vi.fn(),
        whenTerminated: Promise.resolve(),
        dispose: vi.fn(),
    })),
}));

vi.mock('./claudeUnhandledRejectionPolicy', () => ({
    createClaudeShouldTerminateOnUnhandledRejection: vi.fn(() => false),
}));

vi.mock('@/mcp/runtime/resolveRunnerMcpServers', () => ({
    resolveRunnerMcpServers: vi.fn(async (params: any) => {
        lastResolveRunnerMcpServersParams = params;
        return {
        mcpServers: {},
        happierMcpServer: { stop: vi.fn() },
        };
    }),
}));

vi.mock('@/backends/claude/loop', () => ({
    loop: vi.fn(async () => 0),
}));

vi.mock('@/backends/claude/claudeLocal', () => ({
    claudeLocal: claudeLocalMock,
}));

describe('runClaude startup metadata ordering', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        void code;
        return undefined as never;
    }) as typeof process.exit);

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        metadataUpdateDeferred = createDeferred<void>();
        currentMetadataVersion = 1;
        getOrCreateSessionMock.mockImplementation(async () => ({ id: 'session-start', metadataVersion: currentMetadataVersion }));
        runStartupCoordinatorMock.mockImplementation(() => {
            throw new Error('fast-start coordinator should not run');
        });
        claudeLocalMock.mockResolvedValue(undefined);
        lastSessionClient = null;
        lastRuntimeOverridesSynchronizerParams = null;
        lastResolveRunnerMcpServersParams = null;
        probeClaudeInstalledRuntimeCapabilitiesMock.mockReset();
        probeClaudeInstalledRuntimeCapabilitiesMock.mockResolvedValue({
            supportsEffort: true,
            supportsUltracode: true,
        });
        agentStateUpdateSnapshots.length = 0;
        runtimeActivityPublisherCloseMock.mockClear();
        sessionCloseMock.mockReset();
        sessionCloseMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        exitSpy.mockClear();
    });

    it('waits for attach startup metadata writes before seeding runtime overrides', async () => {
        currentMetadataVersion = -1;
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'daemon',
            startingMode: 'remote',
            existingSessionId: 'session-attach',
        }).then(
            () => 'resolved',
            (error) => error,
        );

        await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);

        expect(applyStartupMetadataUpdateToSessionMock).toHaveBeenCalledTimes(1);
        expect(initializeRuntimeOverridesSynchronizerMock).not.toHaveBeenCalled();

        metadataUpdateDeferred.resolve();

        await expect(runPromise).resolves.toBe(stopAfterSeed);
    });

    it('waits for fresh-session startup metadata writes before seeding runtime overrides', async () => {
        currentMetadataVersion = 1;
        const { logger } = await import('@/ui/logger');
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'daemon',
            startingMode: 'remote',
        }).then(
            () => 'resolved',
            (error) => error,
        );

        await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);

        expect(applyStartupMetadataUpdateToSessionMock).toHaveBeenCalledTimes(1);
        expect(initializeRuntimeOverridesSynchronizerMock).not.toHaveBeenCalled();

        metadataUpdateDeferred.resolve();

        await expect(runPromise).resolves.toBe(stopAfterSeed);
        expect(runtimeActivityPublisherCloseMock).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith(
            '[START] Claude startup phase failed',
            expect.objectContaining({
                phase: 'runtime_overrides_seed',
                sessionId: 'session-start',
                startedBy: 'daemon',
                startingMode: 'remote',
                cause: expect.objectContaining({ message: 'stop-after-seed' }),
            }),
        );
    });

    it('passes runtime identity replacement through attach startup metadata writes during handoff resume', async () => {
        currentMetadataVersion = -1;
        const previousAttachMetadataIdentityPolicy = process.env.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY;
        process.env.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY = 'replace_with_runtime_identity';
        try {
            const { runClaude } = await import('./runClaude');

            const runPromise = runClaude(testCredentials, {
                startedBy: 'daemon',
                startingMode: 'remote',
                existingSessionId: 'session-attach',
            }).then(
                () => 'resolved',
                (error) => error,
            );

            await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);

            expect(applyStartupMetadataUpdateToSessionMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    mode: 'attach',
                    attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
                }),
            );

            metadataUpdateDeferred.resolve();

            await expect(runPromise).resolves.toBe(stopAfterSeed);
        } finally {
            if (previousAttachMetadataIdentityPolicy === undefined) {
                delete process.env.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY;
            } else {
                process.env.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY = previousAttachMetadataIdentityPolicy;
            }
        }
    });

    it('reports the canonical session id first for daemon-started attach sessions', async () => {
        currentMetadataVersion = -1;
        initializeRuntimeOverridesSynchronizerMock.mockImplementationOnce(async (params: RuntimeOverridesSynchronizerParams) => {
            lastRuntimeOverridesSynchronizerParams = params;
            return createRuntimeOverridesSynchronizer({
                seedFromSession: vi.fn(async () => {}),
            });
        });
        const { loop } = await import('@/backends/claude/loop');
        vi.mocked(loop).mockImplementationOnce(async (params: any) => {
            await params.onSessionReady(params.session);
            return 0;
        });
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'daemon',
            startingMode: 'remote',
            existingSessionId: 'session-attach',
        }).then(
            () => 'resolved',
            (error) => error,
        );

        await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);

        const reportMock = vi.mocked(reportSessionToDaemonIfRunning);
        reportMock.mockRejectedValueOnce(stopAfterStartupCoordinator);
        expect(reportMock).not.toHaveBeenCalled();

        metadataUpdateDeferred.resolve();
        await expect(runPromise).resolves.toBe(stopAfterStartupCoordinator);

        expect(reportMock.mock.calls.length).toBeGreaterThan(0);
        expect(reportMock.mock.calls[0]?.[0]?.sessionId).toBe('session-attach');
        expect(reportMock.mock.calls.some(([call]) => call?.sessionId === 'PID-12345')).toBe(false);
    });

    it('uses the requested directory seed instead of a canonicalized cwd during remote startup', async () => {
        currentMetadataVersion = 1;
        const previousRequestedDirectory = process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY;
        process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY = '/tmp/requested-remote-directory';
        try {
            const { runClaude } = await import('./runClaude');

            const runPromise = runClaude(testCredentials, {
                startedBy: 'daemon',
                startingMode: 'remote',
            }).then(
                () => 'resolved',
                (error) => error,
            );

            await waitFor(() => createSessionMetadataMock.mock.calls.length === 1);

            expect(createSessionMetadataMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    directory: '/tmp/requested-remote-directory',
                }),
            );

            metadataUpdateDeferred.resolve();

            await expect(runPromise).resolves.toBe(stopAfterSeed);
        } finally {
            if (previousRequestedDirectory === undefined) {
                delete process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY;
            } else {
                process.env.HAPPIER_SESSION_REQUESTED_DIRECTORY = previousRequestedDirectory;
            }
        }
    });

    it('bypasses local fast-start for terminal-started unified sessions', async () => {
        currentMetadataVersion = 1;
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'terminal',
            startingMode: 'local',
            claudeRemoteMetaDefaults: {
                claudeUnifiedTerminalEnabled: true,
            },
        }).then(
            () => 'resolved',
            (error) => error,
        );

        await waitFor(() =>
            applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1
            || runStartupCoordinatorMock.mock.calls.length > 0,
        );

        expect(runStartupCoordinatorMock).not.toHaveBeenCalled();
        expect(applyStartupMetadataUpdateToSessionMock).toHaveBeenCalledTimes(1);

        metadataUpdateDeferred.resolve();

        await expect(runPromise).resolves.toBe(stopAfterSeed);
    });

    it('does not publish standard startup user-message readiness until after the listener is subscribed', async () => {
        currentMetadataVersion = 1;
        initializeRuntimeOverridesSynchronizerMock.mockImplementationOnce(async (params: RuntimeOverridesSynchronizerParams) => {
            lastRuntimeOverridesSynchronizerParams = params;
            return createRuntimeOverridesSynchronizer({
                seedFromSession: vi.fn(async () => {}),
                syncFromMetadata: vi.fn(),
            });
        });
        const { updateAgentStateBestEffort } = await import('@/api/session/sessionWritesBestEffort');
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'daemon',
            startingMode: 'remote',
        }).then(
            () => 'resolved',
            (error) => error,
        );

        await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);
        metadataUpdateDeferred.resolve();

        await expect(runPromise).resolves.toBe('resolved');

        const updateMock = vi.mocked(updateAgentStateBestEffort);
        const initialCall = updateMock.mock.calls.find((call) => call[3] === 'initial_agent_state');
        const readyCall = updateMock.mock.calls.find((call) => call[3] === 'user_message_handler_ready');
        expect(initialCall).toBeTruthy();
        expect(readyCall).toBeTruthy();
        expect(lastSessionClient?.onUserMessage).toHaveBeenCalledTimes(1);

        const initialState = agentStateUpdateSnapshots.find((snapshot) => snapshot.reason === 'initial_agent_state')?.state;
        const readyState = agentStateUpdateSnapshots.find((snapshot) => snapshot.reason === 'user_message_handler_ready')?.state;
        expect(initialState?.capabilities).toMatchObject({ userMessageHandlerReady: false });
        expect(readyState?.capabilities).toMatchObject({ userMessageHandlerReady: true });
        expect(updateMock.mock.invocationCallOrder[updateMock.mock.calls.indexOf(initialCall!)]).toBeLessThan(
            lastSessionClient!.onUserMessage.mock.invocationCallOrder[0]!,
        );
        expect(lastSessionClient!.onUserMessage.mock.invocationCallOrder[0]!).toBeLessThan(
            updateMock.mock.invocationCallOrder[updateMock.mock.calls.indexOf(readyCall!)]!,
        );
        expect(runtimeActivityPublisherCloseMock).toHaveBeenCalledTimes(1);
    });

    it('keeps Agent SDK capabilities and stop semantics after a later message selects Unified terminal', async () => {
        currentMetadataVersion = 1;
        initializeRuntimeOverridesSynchronizerMock.mockImplementationOnce(async (params: RuntimeOverridesSynchronizerParams) => {
            lastRuntimeOverridesSynchronizerParams = params;
            return createRuntimeOverridesSynchronizer({
                seedFromSession: vi.fn(async () => {}),
                syncFromMetadata: vi.fn(),
            });
        });
        const { registerKillSessionHandler } = await import('@/rpc/handlers/killSession');
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'daemon',
            startingMode: 'remote',
            claudeRemoteMetaDefaults: {
                claudeRemoteAgentSdkEnabled: true,
                claudeUnifiedTerminalEnabled: false,
                claudeLocalPermissionBridgeEnabled: false,
            },
        });

        await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);
        metadataUpdateDeferred.resolve();
        await runPromise;

        const userMessageHandler = lastSessionClient?.onUserMessage.mock.calls[0]?.[0] as ((message: {
            content: { type: 'text'; text: string };
            localId: string;
            meta: Record<string, unknown>;
        }) => void) | undefined;
        expect(userMessageHandler).toBeTypeOf('function');
        userMessageHandler?.({
            content: { type: 'text', text: 'keep using the active runtime' },
            localId: 'runtime-selection-change',
            meta: {
                claudeRemoteAgentSdkEnabled: true,
                claudeUnifiedTerminalEnabled: true,
                claudeLocalPermissionBridgeEnabled: true,
            },
        });

        const stateAfterPreferenceChange = agentStateUpdateSnapshots.find(
            (snapshot) => snapshot.reason === 'local_permission_bridge_mode_change',
        )?.state;
        expect(stateAfterPreferenceChange).toMatchObject({
            controlledByUser: false,
            localControl: null,
        });
        expect(stateAfterPreferenceChange?.capabilities?.inFlightSteerSupported).toBeUndefined();

        const killHandler = vi.mocked(registerKillSessionHandler).mock.calls[0]?.[1];
        expect(killHandler).toBeTypeOf('function');
        await expect(killHandler?.()).resolves.toBeUndefined();
    });

    it('removes unsupported installed effort and ultracode from ordinary message launch modes after one probe', async () => {
        currentMetadataVersion = 1;
        probeClaudeInstalledRuntimeCapabilitiesMock.mockResolvedValue({
            supportsEffort: false,
            supportsUltracode: false,
        });
        initializeRuntimeOverridesSynchronizerMock.mockImplementationOnce(async (params: RuntimeOverridesSynchronizerParams) => {
            lastRuntimeOverridesSynchronizerParams = params;
            return createRuntimeOverridesSynchronizer({
                seedFromSession: vi.fn(async () => {}),
                syncFromMetadata: vi.fn(),
            });
        });
        const { loop } = await import('@/backends/claude/loop');
        const launchModes: unknown[] = [];
        vi.mocked(loop).mockImplementationOnce(async (params: any) => {
            params.messageQueue.push = vi.fn((_text: string, mode: unknown) => launchModes.push(mode));
            const handler = lastSessionClient?.onUserMessage.mock.calls[0]?.[0];
            await handler?.({
                content: { type: 'text', text: 'ship it' },
                localId: 'effort-gated',
                createdAt: 101,
                meta: { model: 'claude-fable-5', reasoningEffort: 'xhigh', ultracode: true },
            });
            return 0;
        });
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'daemon',
            startingMode: 'remote',
            model: 'claude-fable-5',
        });
        await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);
        metadataUpdateDeferred.resolve();
        await runPromise;

        expect(launchModes).toEqual([
            expect.not.objectContaining({ reasoningEffort: expect.anything(), ultracode: expect.anything() }),
        ]);
        expect(probeClaudeInstalledRuntimeCapabilitiesMock).toHaveBeenCalledTimes(1);
    });

    it('retains discovered model effort evidence for the initial ordinary launch after readiness', async () => {
        vi.doMock('@/backends/claude/models/resolveClaudeModelCatalog', async (importOriginal) => {
            const actual = await importOriginal<typeof import('@/backends/claude/models/resolveClaudeModelCatalog')>();
            return {
                ...actual,
                resolveClaudeModelCatalog: vi.fn(async () => [{
                    id: 'claude-opus-9',
                    name: 'Opus 9',
                    modelOptions: [{
                        id: 'reasoning_effort',
                        name: 'Thinking',
                        type: 'select',
                        currentValue: 'high',
                        options: [
                            { value: 'low', name: 'Low' },
                            { value: 'high', name: 'High' },
                            { value: 'xhigh', name: 'XHigh' },
                        ],
                    }],
                }]),
            };
        });
        vi.doMock('@/backends/claude/sessionControls/publishClaudeSessionModelsMetadataBestEffort', () => ({
            publishClaudeSessionModelsMetadataBestEffort: vi.fn(async () => {}),
        }));
        initializeRuntimeOverridesSynchronizerMock.mockImplementationOnce(async (params: RuntimeOverridesSynchronizerParams) => {
            lastRuntimeOverridesSynchronizerParams = params;
            return createRuntimeOverridesSynchronizer({
                seedFromSession: vi.fn(async () => {}),
                syncFromMetadata: vi.fn(),
            });
        });
        const { loop } = await import('@/backends/claude/loop');
        type LoopParams = Parameters<typeof loop>[0];
        const reportMock = vi.mocked(reportSessionToDaemonIfRunning);
        reportMock.mockRejectedValueOnce(stopAfterStartupCoordinator);
        let initialMode: LoopParams['initialClaudeUnifiedTerminalMode'];
        vi.mocked(loop).mockImplementationOnce(async (params: LoopParams) => {
            initialMode = params.initialClaudeUnifiedTerminalMode;
            const onSessionReady = params.onSessionReady;
            if (!onSessionReady) throw new Error('Expected Claude session readiness callback');
            await onSessionReady(createPermissionHandlerSessionStub('session-start').session);
            return 0;
        });
        const { runClaude } = await import('./runClaude');

        try {
            const runPromise = runClaude(testCredentials, {
                startedBy: 'daemon',
                startingMode: 'remote',
                model: 'claude-opus-9',
            }).then(
                () => 'resolved',
                (error) => error,
            );
            await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);
            metadataUpdateDeferred.resolve();
            await expect(runPromise).resolves.toBe(stopAfterStartupCoordinator);

            expect(initialMode).toMatchObject({
                model: 'claude-opus-9',
                modelEffortLevels: ['low', 'high', 'xhigh'],
                modelEffortLevelsModelId: 'claude-opus-9',
            });
        } finally {
            vi.doUnmock('@/backends/claude/models/resolveClaudeModelCatalog');
            vi.doUnmock('@/backends/claude/sessionControls/publishClaudeSessionModelsMetadataBestEffort');
        }
    });

    it('disposes runtime Activity when standard session transport close fails', async () => {
        currentMetadataVersion = 1;
        const closeError = new Error('session-close-failed');
        sessionCloseMock.mockRejectedValueOnce(closeError);
        initializeRuntimeOverridesSynchronizerMock.mockImplementationOnce(async (params: RuntimeOverridesSynchronizerParams) => {
            lastRuntimeOverridesSynchronizerParams = params;
            return createRuntimeOverridesSynchronizer({
                seedFromSession: vi.fn(async () => {}),
                syncFromMetadata: vi.fn(),
            });
        });
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'daemon',
            startingMode: 'remote',
        }).then(
            () => 'resolved',
            (error) => error,
        );

        await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);
        metadataUpdateDeferred.resolve();

        await expect(runPromise).resolves.toBe(closeError);
        expect(runtimeActivityPublisherCloseMock).toHaveBeenCalledTimes(1);
    });

    it('applies startup permission overrides before unified terminal startup continues', async () => {
        currentMetadataVersion = 1;
        initializeRuntimeOverridesSynchronizerMock.mockImplementationOnce(async (params: RuntimeOverridesSynchronizerParams) => {
            lastRuntimeOverridesSynchronizerParams = params;
            return createRuntimeOverridesSynchronizer({
                seedFromSession: async () => {
                    const capturedParams = lastRuntimeOverridesSynchronizerParams;
                    if (!capturedParams) throw new Error('missing runtime override synchronizer params');
                    capturedParams.permissionMode.current = 'acceptEdits';
                    capturedParams.permissionMode.updatedAt = 123;
                    capturedParams.onPermissionModeApplied?.();
                    throw stopAfterSeed;
                },
            });
        });
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'terminal',
            startingMode: 'local',
            claudeRemoteMetaDefaults: {
                claudeUnifiedTerminalEnabled: true,
            },
        }).then(
            () => 'resolved',
            (error) => error,
        );

        await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);

        metadataUpdateDeferred.resolve();

        await expect(runPromise).resolves.toBe(stopAfterSeed);
    });

    it('preserves unified terminal selection during server-unreachable terminal startup', async () => {
        currentMetadataVersion = 1;
        getOrCreateSessionMock.mockResolvedValueOnce(null);
        runStartupCoordinatorMock.mockImplementationOnce(() => {
            throw stopAfterStartupCoordinator;
        });
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'terminal',
            startingMode: 'local',
            claudeRemoteMetaDefaults: {
                claudeUnifiedTerminalEnabled: true,
            },
        }).then(
            () => 'resolved',
            (error) => error,
        );

        const result = await runPromise;
        expect(claudeLocalMock).not.toHaveBeenCalled();
        expect(result).toBe(stopAfterStartupCoordinator);
        expect(runStartupCoordinatorMock).toHaveBeenCalledWith(
            expect.objectContaining({
                ctx: expect.objectContaining({
                    backendId: 'claude',
                    startedBy: 'terminal',
                    startingModeIntent: 'local',
                }),
            }),
        );
    });

    it('surfaces MCP resolution failures that happen after daemon session registration', async () => {
        currentMetadataVersion = 1;
        initializeRuntimeOverridesSynchronizerMock.mockResolvedValueOnce(createRuntimeOverridesSynchronizer({
            seedFromSession: async () => undefined,
        }));
        const mcpError = new Error('missing MCP secret');
        const { resolveRunnerMcpServers } = await import('@/mcp/runtime/resolveRunnerMcpServers');
        vi.mocked(resolveRunnerMcpServers).mockRejectedValueOnce(mcpError);
        const { logger } = await import('@/ui/logger');
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'daemon',
            startingMode: 'remote',
        }).then(
            () => 'resolved',
            (error) => error,
        );

        await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);
        metadataUpdateDeferred.resolve();

        await expect(runPromise).resolves.toBe(mcpError);
        expect(lastSessionClient?.sendSessionEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'message',
                message: expect.stringContaining('Failed to prepare MCP servers'),
            }),
        );
        expect(logger.debug).toHaveBeenCalledWith(
            '[START] Failed to resolve runner MCP servers',
            expect.objectContaining({ message: 'missing MCP secret' }),
        );
    });

    it('exposes the current permission mode to the regular Happier MCP bridge setup path', async () => {
        currentMetadataVersion = 1;
        initializeRuntimeOverridesSynchronizerMock.mockImplementationOnce(async (params: RuntimeOverridesSynchronizerParams) => {
            lastRuntimeOverridesSynchronizerParams = params;
            return createRuntimeOverridesSynchronizer({
                seedFromSession: async () => {
                    params.permissionMode.current = 'yolo';
                    params.permissionMode.updatedAt = 123;
                    params.onPermissionModeApplied?.();
                },
            });
        });
        const { runClaude } = await import('./runClaude');

        const runPromise = runClaude(testCredentials, {
            startedBy: 'daemon',
            startingMode: 'remote',
        }).then(
            () => 'resolved',
            (error) => error,
        );

        await waitFor(() => applyStartupMetadataUpdateToSessionMock.mock.calls.length === 1);
        metadataUpdateDeferred.resolve();
        await waitFor(() => Boolean(lastResolveRunnerMcpServersParams?.session), 10_000);

        expect(lastResolveRunnerMcpServersParams.session.getPermissionMode?.()).toBe('yolo');

        await expect(runPromise).resolves.toBe('resolved');
    });

});
