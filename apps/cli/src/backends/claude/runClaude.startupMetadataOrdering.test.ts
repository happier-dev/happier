import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';
import { createClaudeSessionRuntimePlan } from '@/backends/claude/runtime/createSessionPlan';
import { runHostSessionRuntime } from '@/agent/runtime/session/loop/runHostSessionRuntime';

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

const {
    initializeBackendApiContextMock,
    applyStartupMetadataUpdateToSessionMock,
    createSessionMetadataMock,
    createBaseSessionForAttachMock,
    initializeRuntimeOverridesSynchronizerMock,
    readSettingsMock,
} = vi.hoisted(() => ({
    initializeBackendApiContextMock: vi.fn(async () => ({
        api: {
            getOrCreateSession: vi.fn(async () => ({ id: 'session-start', metadataVersion: currentMetadataVersion })),
            sessionSyncClient: vi.fn(() => ({
                sessionId: 'session-start',
                rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn() },
                ensureMetadataSnapshot: vi.fn(async () => metadataSnapshot ?? { path: '/srv/project' }),
                getMetadataSnapshot: vi.fn(() => metadataSnapshot ?? { path: '/srv/project' }),
                onUserMessage: vi.fn((handler: (message: any) => void) => {
                    capturedUserMessageHandler = handler;
                }),
                sendSessionEvent: vi.fn(),
                sendClaudeSessionMessage: vi.fn(),
                sendAgentMessage: vi.fn(),
                sendCodexMessage: vi.fn(),
                sendUserTextMessage: vi.fn(),
                updateMetadata: vi.fn(),
                updateAgentState: vi.fn(),
                keepAlive: vi.fn(),
                waitForMetadataUpdate: vi.fn(async () => true),
                popPendingMessage: vi.fn(async () => false),
                peekPendingMessageQueueV2Count: vi.fn(async () => 0),
                discardPendingMessageQueueV2All: vi.fn(async () => 0),
                discardCommittedMessageLocalIds: vi.fn(async () => 0),
                sendSessionDeath: vi.fn(),
                flush: vi.fn(async () => {}),
                close: vi.fn(async () => {}),
            })),
            push: vi.fn(() => ({ sendToAllDevices: vi.fn() })),
        },
        machineId: 'machine_1',
    })),
    applyStartupMetadataUpdateToSessionMock: vi.fn(() => metadataUpdateDeferred.promise),
    createSessionMetadataMock: vi.fn(() => ({
        state: { controlledByUser: false },
        metadata: { path: '/tmp/project', terminal: null },
    })),
    createBaseSessionForAttachMock: vi.fn(async () => ({
        id: 'session-attach',
        metadataVersion: currentMetadataVersion,
    })),
    initializeRuntimeOverridesSynchronizerMock: vi.fn(async () => ({
        seedFromSession: async () => {
            throw stopAfterSeed;
        },
        syncFromMetadata: vi.fn(),
        getSnapshot: () => ({
            permissionMode: { current: 'default', updatedAt: 0 },
            modelOverride: { current: null, updatedAt: 0 },
        }),
    })),
    readSettingsMock: vi.fn(async () => ({ machineId: 'machine_1' })),
}));

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error(`Timed out after ${timeoutMs}ms`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
}

async function waitForOrRunResult(
    predicate: () => boolean,
    runResult: Promise<unknown>,
    timeoutMs = 5000,
): Promise<void> {
    let settled = false;
    let resolution: unknown;
    void runResult.then((value) => {
        settled = true;
        resolution = value;
    });

    const startedAt = Date.now();
    while (!predicate()) {
        if (settled) {
            throw resolution instanceof Error ? resolution : new Error(`Run settled early: ${String(resolution)}`);
        }
        if (Date.now() - startedAt > timeoutMs) {
            throw new Error(
                `Timed out after ${timeoutMs}ms (progress=${JSON.stringify(liveHostPathProgress)}, createSessionMetadata=${createSessionMetadataMock.mock.calls.length}, initializeBackendApiContext=${initializeBackendApiContextMock.mock.calls.length}, createBaseSessionForAttach=${createBaseSessionForAttachMock.mock.calls.length}, applyStartupMetadataUpdate=${applyStartupMetadataUpdateToSessionMock.mock.calls.length})`,
            );
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
const testCredentials: Credentials = {
    token: 'test',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

let metadataUpdateDeferred: Deferred<void>;
let capturedUserMessageHandler: ((message: any) => void) | null = null;
let metadataSnapshot: Record<string, unknown> | null = null;
let currentMetadataVersion = 1;
const liveHostPathProgress = {
    importedPlanModule: false,
    importedRunnerModule: false,
    createdPlan: false,
    enteredRun: false,
};

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
    startOfflineReconnection: vi.fn(),
}));

vi.mock('@/agent/runtime/initializeBackendApiContext', () => ({
    initializeBackendApiContext: initializeBackendApiContextMock,
}));

vi.mock('@/agent/runtime/createSessionMetadata', () => ({
    createSessionMetadata: createSessionMetadataMock,
}));

vi.mock('@/agent/runtime/createBaseSessionForAttach', () => ({
    createBaseSessionForAttach: createBaseSessionForAttachMock,
}));

vi.mock('@/agent/runtime/startupMetadataUpdate', () => ({
    applyStartupMetadataUpdateToSession: applyStartupMetadataUpdateToSessionMock,
    buildSessionModeOverride: vi.fn(() => null),
    buildModelOverride: vi.fn(() => null),
    buildPermissionModeOverride: vi.fn(() => null),
}));

vi.mock('@/agent/runtime/runtimeOverridesSynchronizer', () => ({
    initializeRuntimeOverridesSynchronizer: initializeRuntimeOverridesSynchronizerMock,
}));

vi.mock('@/persistence', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/persistence')>();
    return {
        ...actual,
        readSettings: readSettingsMock,
    };
});

vi.mock('@/agent/runtime/startupSideEffects', () => ({
    primeAgentStateForUi: vi.fn(),
    persistTerminalAttachmentInfoIfNeeded: vi.fn(async () => {}),
    reportSessionToDaemonIfRunning: vi.fn(async () => {}),
    sendTerminalFallbackMessageIfNeeded: vi.fn(),
}));

vi.mock('@/backends/claude/utils/startHookServer', () => ({
    startHookServer: vi.fn(async () => ({ port: 12345, stop: vi.fn() })),
}));

vi.mock('@/backends/claude/utils/generateHookSettingsFileWithEnsuredRuntime', () => ({
    generateHookSettingsFileWithEnsuredRuntime: vi.fn(async () => '/tmp/happier-hook-settings.json'),
    generateHookPluginDirWithEnsuredRuntime: vi.fn(async () => '/tmp/happier-hook-plugin'),
}));

vi.mock('@/backends/claude/utils/generateHookSettings', () => ({
    cleanupHookSettingsFile: vi.fn(),
}));

vi.mock('@/rpc/handlers/killSession', () => ({
    registerKillSessionHandler: vi.fn(),
}));

vi.mock('@/api/session/sessionWritesBestEffort', () => ({
    updateAgentStateBestEffort: vi.fn(),
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

vi.mock('@/agent/runtime/lifecycle/runnerTerminationOutcome', () => ({
    computeRunnerTerminationOutcome: vi.fn(() => ({ exitCode: 0, archive: false, archiveReason: null })),
}));

vi.mock('@/agent/runtime/lifecycle/runnerTerminationHandlers', () => ({
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
    resolveRunnerMcpServers: vi.fn(async () => ({
        mcpServers: {},
        happierMcpServer: { stop: vi.fn() },
    })),
}));

async function runClaudeViaLiveHostPath(
    credentials: Credentials,
    options: Record<string, unknown>,
): Promise<void> {
    liveHostPathProgress.importedPlanModule = false;
    liveHostPathProgress.importedRunnerModule = false;
    liveHostPathProgress.createdPlan = false;
    liveHostPathProgress.enteredRun = false;
    liveHostPathProgress.importedPlanModule = true;
    liveHostPathProgress.importedRunnerModule = true;

    const plan = createClaudeSessionRuntimePlan({
        credentials,
        ...options,
    });
    expect(plan.config).not.toHaveProperty('hostBootstrap');
    liveHostPathProgress.createdPlan = true;

    liveHostPathProgress.enteredRun = true;
    await runHostSessionRuntime(plan.opts, plan.config, {
        runSessionLoopLifecycleFn: async ({ startupCoordinator }) => {
            await startupCoordinator?.start?.();
        },
    });
}

describe('Claude host-owned startup metadata ordering', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        void code;
        return undefined as never;
    }) as typeof process.exit);

    beforeEach(() => {
        vi.clearAllMocks();
        readSettingsMock.mockResolvedValue({ machineId: 'machine_1' });
        metadataUpdateDeferred = createDeferred<void>();
        capturedUserMessageHandler = null;
        metadataSnapshot = null;
        currentMetadataVersion = 1;
        liveHostPathProgress.importedPlanModule = false;
        liveHostPathProgress.importedRunnerModule = false;
        liveHostPathProgress.createdPlan = false;
        liveHostPathProgress.enteredRun = false;
    });

    afterEach(() => {
        // Provider runners must not hard-exit the process. Host owns termination policy.
        expect(exitSpy).not.toHaveBeenCalled();
        exitSpy.mockClear();
    });

    async function withFastStartAttachEnv<T>(fn: () => Promise<T>): Promise<T> {
        const previousAttachFile = process.env.HAPPIER_SESSION_ATTACH_FILE;
        process.env.HAPPIER_SESSION_ATTACH_FILE = '/tmp/claude-fast-start-attach.json';
        try {
            return await fn();
        } finally {
            if (previousAttachFile === undefined) {
                delete process.env.HAPPIER_SESSION_ATTACH_FILE;
            } else {
                process.env.HAPPIER_SESSION_ATTACH_FILE = previousAttachFile;
            }
        }
    }

    it('waits for attach startup metadata writes before seeding runtime overrides', async () => {
        currentMetadataVersion = -1;
        await withFastStartAttachEnv(async () => {
            const runPromise = runClaudeViaLiveHostPath(testCredentials, {
                startedBy: 'terminal',
                startingMode: 'local',
                existingSessionId: 'session-attach',
                permissionMode: 'default',
            }).then(
                () => 'resolved',
                (error) => error,
            );

            await waitForOrRunResult(
                () => applyStartupMetadataUpdateToSessionMock.mock.calls.length > 0,
                runPromise,
            );

            expect(applyStartupMetadataUpdateToSessionMock).toHaveBeenCalledTimes(1);
            expect(initializeRuntimeOverridesSynchronizerMock).not.toHaveBeenCalled();

            metadataUpdateDeferred.resolve();
            await waitFor(() => initializeRuntimeOverridesSynchronizerMock.mock.calls.length > 0);

            await expect(runPromise).resolves.toBe('resolved');
        });
    });

    it('passes runtime identity replacement through attach startup metadata writes during handoff resume', async () => {
        currentMetadataVersion = -1;
        const previousAttachMetadataIdentityPolicy = process.env.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY;
        process.env.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY = 'replace_with_runtime_identity';
        try {
            await withFastStartAttachEnv(async () => {
                const runPromise = runClaudeViaLiveHostPath(testCredentials, {
                    startedBy: 'terminal',
                    startingMode: 'local',
                    existingSessionId: 'session-attach',
                    permissionMode: 'default',
                }).then(
                    () => 'resolved',
                    (error) => error,
                );

                await waitForOrRunResult(
                    () => applyStartupMetadataUpdateToSessionMock.mock.calls.length > 0,
                    runPromise,
                );

                expect(applyStartupMetadataUpdateToSessionMock).toHaveBeenCalledWith(
                    expect.objectContaining({
                        mode: 'attach',
                        attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
                    }),
                );

                metadataUpdateDeferred.resolve();
                await waitFor(() => initializeRuntimeOverridesSynchronizerMock.mock.calls.length > 0);

                await expect(runPromise).resolves.toBe('resolved');
            });
        } finally {
            if (previousAttachMetadataIdentityPolicy === undefined) {
                delete process.env.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY;
            } else {
                process.env.HAPPIER_SESSION_ATTACH_METADATA_IDENTITY_POLICY = previousAttachMetadataIdentityPolicy;
            }
        }
    });

    it('reports the canonical session id first for deferred attach sessions', async () => {
        currentMetadataVersion = -1;
        await withFastStartAttachEnv(async () => {
            const runPromise = runClaudeViaLiveHostPath(testCredentials, {
                startedBy: 'terminal',
                startingMode: 'local',
                existingSessionId: 'session-attach',
                permissionMode: 'default',
            }).then(
                () => 'resolved',
                (error) => error,
            );

            await waitForOrRunResult(
                () => applyStartupMetadataUpdateToSessionMock.mock.calls.length > 0,
                runPromise,
            );

            metadataUpdateDeferred.resolve();
            const reportMock = vi.mocked(reportSessionToDaemonIfRunning);
            await waitFor(() => reportMock.mock.calls.length > 0);
            expect(reportMock.mock.calls[0]?.[0]?.sessionId).toBe('session-attach');
            expect(reportMock.mock.calls.some(([call]) => call?.sessionId === 'PID-12345')).toBe(false);

            await waitFor(() => initializeRuntimeOverridesSynchronizerMock.mock.calls.length > 0);

            await expect(runPromise).resolves.toBe('resolved');
        });
    });

    it('uses the requested directory seed passed into the deferred attach path', async () => {
        currentMetadataVersion = 1;
        await withFastStartAttachEnv(async () => {
            const runPromise = runClaudeViaLiveHostPath(testCredentials, {
                startedBy: 'terminal',
                startingMode: 'local',
                existingSessionId: 'session-attach',
                permissionMode: 'default',
                directory: '/tmp/requested-remote-directory',
            }).then(
                () => 'resolved',
                (error) => error,
            );

            await waitFor(() => createSessionMetadataMock.mock.calls.length > 0);

            expect(createSessionMetadataMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    directory: '/tmp/requested-remote-directory',
                }),
            );

            metadataUpdateDeferred.resolve();
            await waitFor(() => initializeRuntimeOverridesSynchronizerMock.mock.calls.length > 0);

            await expect(runPromise).resolves.toBe('resolved');
        });
    });
});
