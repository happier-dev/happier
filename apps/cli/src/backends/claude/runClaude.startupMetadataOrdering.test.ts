import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { reportSessionToDaemonIfRunning } from '@/agent/runtime/startupSideEffects';

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
};

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
const testCredentials: Credentials = {
    token: 'test',
    encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
};

let metadataUpdateDeferred: Deferred<void>;
let currentMetadataVersion = 1;

const applyStartupMetadataUpdateToSessionMock = vi.fn(() => metadataUpdateDeferred.promise);
const initializeRuntimeOverridesSynchronizerMock = vi.fn(async () => ({
    seedFromSession: async () => {
        throw stopAfterSeed;
    },
    syncFromMetadata: vi.fn(),
    getSnapshot: () => ({
        permissionMode: { current: 'default', updatedAt: 0 },
        modelOverride: { current: null, updatedAt: 0 },
    }),
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
    startOfflineReconnection: vi.fn(),
}));

vi.mock('@/agent/runtime/initializeBackendApiContext', () => ({
    initializeBackendApiContext: vi.fn(async () => ({
        api: {
            getOrCreateSession: vi.fn(async () => ({ id: 'session-start', metadataVersion: currentMetadataVersion })),
            sessionSyncClient: vi.fn(() => ({
                sessionId: 'session-start',
                rpcHandlerManager: { registerHandler: vi.fn(), invokeLocal: vi.fn() },
                ensureMetadataSnapshot: vi.fn(async () => ({ path: '/srv/project' })),
                getMetadataSnapshot: vi.fn(() => ({ path: '/srv/project' })),
                onUserMessage: vi.fn(),
                sendSessionEvent: vi.fn(),
                updateMetadata: vi.fn(),
                updateAgentState: vi.fn(),
                sendSessionDeath: vi.fn(),
                flush: vi.fn(async () => {}),
                close: vi.fn(async () => {}),
            })),
            push: vi.fn(() => ({ sendToAllDevices: vi.fn() })),
        },
        machineId: 'machine_1',
    })),
}));

vi.mock('@/agent/runtime/createSessionMetadata', () => ({
    createSessionMetadata: vi.fn(() => ({
        state: { controlledByUser: false },
        metadata: { path: '/tmp/project', terminal: null },
    })),
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

vi.mock('@/backends/claude/utils/startHookServer', () => ({
    startHookServer: vi.fn(async () => ({ port: 12345, stop: vi.fn() })),
}));

vi.mock('@/backends/claude/utils/generateHookSettingsFileWithEnsuredRuntime', () => ({
    generateHookSettingsFileWithEnsuredRuntime: vi.fn(async () => '/tmp/happier-hook-settings.json'),
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

vi.mock('@/agent/runtime/runnerTerminationOutcome', () => ({
    computeRunnerTerminationOutcome: vi.fn(() => ({ exitCode: 0, archive: false, archiveReason: null })),
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
    resolveRunnerMcpServers: vi.fn(async () => ({
        mcpServers: {},
        happierMcpServer: { stop: vi.fn() },
    })),
}));

vi.mock('@/backends/claude/loop', () => ({
    loop: vi.fn(async () => 0),
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
        expect(reportMock.mock.calls.length).toBeGreaterThan(0);
        expect(reportMock.mock.calls[0]?.[0]?.sessionId).toBe('session-attach');
        expect(reportMock.mock.calls.some(([call]) => call?.sessionId === 'PID-12345')).toBe(false);

        metadataUpdateDeferred.resolve();

        await expect(runPromise).resolves.toBe(stopAfterSeed);
    });
});
