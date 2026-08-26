import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import type { ApiMachineClient } from '@/api/apiMachine';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;
type MachineRpcHandlers = Parameters<ApiMachineClient['setRPCHandlers']>[0];
const loggerDebug = vi.hoisted(() => vi.fn());

const harness = vi.hoisted(() => {
    let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
    let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;
    const credentials = {
        token: 'token-session-handoff',
        encryption: {
            type: 'dataKey' as const,
            publicKey: new Uint8Array(32).fill(1),
            machineKey: new Uint8Array(32).fill(2),
        },
    };

    let hasPublishedTransfers = false;
    const directPeerRegistry = {
        publishTransfer: vi.fn(() => {
            hasPublishedTransfers = true;
            return {
                transferId: 'handoff_1',
                transferToken: 'token_1',
                endpointCandidates: [{ kind: 'http' as const, url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_1', authorizationToken: 'token_1', expiresAt: 30_000 }],
                expiresAt: 30_000,
            };
        }),
        readPublishedTransfer: vi.fn(() => null),
        resolveOnDemandTransferOnOpen: vi.fn(async () => null),
        clearPublishedTransfer: vi.fn(() => {
            hasPublishedTransfers = false;
        }),
        cleanupExpiredPublishedTransfers: vi.fn(),
        getNextPublishedTransferExpiryAt: vi.fn(() => null),
        hasPublishedTransfers: vi.fn(() => hasPublishedTransfers),
        dispose: vi.fn(async () => {
            hasPublishedTransfers = false;
        }),
    };
    const startAutomationWorker = vi.fn(() => ({
        stop: vi.fn(),
        refreshAssignments: vi.fn(async () => {}),
        handleServerUpdate: vi.fn(),
    }));
    const apiMachine = {
        setRPCHandlers: vi.fn((_handlers: MachineRpcHandlers) => ({
            externalSessionPluginAdmissionOwner: undefined,
        })),
        getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
            invokeLocal: vi.fn(async () => ({ ok: true })),
        })),
        registerLocalServicesPreviewRoutes: vi.fn(),
        registerLocalServicesRoutes: vi.fn(),
        registerBrowserControlRoutes: vi.fn(),
        registerBrowserContextRoutes: vi.fn(),
        registerBrowserDiagnosticsRoutes: vi.fn(),
        registerBrowserRecordingRoutes: vi.fn(),
        registerSimulatorPreviewRoutes: vi.fn(),
        registerConnectedAccountDaemonRuntime: vi.fn(),
        registerConnectedAccountPurposeBindingRuntime: vi.fn(),
        registerLiveStreamRelayRoutes: vi.fn(),
        onUpdate: vi.fn(() => () => {}),
        onAccountSettingsVersionHint: vi.fn(() => () => {}),
        onPendingSessionActivationHint: vi.fn(() => () => {}),
        onConnectedServicesProjection: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn((params?: { onConnect?: () => void | Promise<void> }) => {
            void params?.onConnect?.();
        }),
        callMachineRpc: vi.fn(async () => ({})),
        updateMachineMetadata: vi.fn(async () => {}),
        updateDaemonState: vi.fn(async () => {}),
        awaitPendingRpcRequests: vi.fn(async () => {}),
        shutdown: vi.fn(),
        onMachineTransferEnvelope: vi.fn(() => () => {}),
        sendMachineTransferEnvelope: vi.fn(),
        onTransferRelayV2Envelope: vi.fn(() => () => {}),
        sendTransferRelayV2Envelope: vi.fn(),
        onPeerTcpTunnelRelayEnvelope: vi.fn(() => () => {}),
        sendPeerTcpTunnelRelayEnvelope: vi.fn(),
        onMachineLiveStreamRelayEnvelope: vi.fn(() => () => {}),
        sendMachineLiveStreamRelayEnvelope: vi.fn(),
        emitExternalSessionTranscriptUpdate: vi.fn(),
        executeExternalSessionHistoricalImportCommand: vi.fn(async () => ({ ok: true })),
    };
    const lockHandle = { release: vi.fn(async () => {}) };
    const createDaemonShutdownController = vi.fn(() => {
        const resolvesWhenShutdownRequested = new Promise<{ source: ShutdownSource; errorMessage?: string }>((resolve) => {
            resolveShutdown = resolve;
        });
        const requestShutdown = (source: ShutdownSource, errorMessage?: string) => {
            resolveShutdown?.({ source, errorMessage });
        };
        requestShutdownRef = requestShutdown;
        return {
            requestShutdown,
            resolvesWhenShutdownRequested,
        };
    });

    return {
        directPeerRegistry,
        requestDirectPeerTransferToFile: vi.fn(async ({ destinationPath }: { destinationPath: string }) => ({
            destinationPath,
            manifestHash: 'sha256:test-manifest',
            sizeBytes: 0,
        })),
        startAutomationWorker,
        apiMachine,
        lockHandle,
        createDaemonShutdownController,
        credentials,
        requestShutdown: (source: ShutdownSource) => requestShutdownRef?.(source),
    };
});

function requireRegisteredMachineRpcHandlers(): MachineRpcHandlers {
    const handlers = harness.apiMachine.setRPCHandlers.mock.calls[0]?.[0];
    if (!handlers) {
        throw new Error('Expected registered machine RPC handlers');
    }
    return handlers;
}

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            machineSyncClient: vi.fn(() => harness.apiMachine),
            setServerFeaturesSnapshotProvider: vi.fn(),
            createBrowserRuntimeActionExecutor: vi.fn(() => vi.fn()),
            getAccountEncryptionMode: vi.fn(async () => 'plain'),
            getConnectedServiceAuthGroup: vi.fn(async () => null),
        })),
    },
    isMachineContentPublicKeyMismatchError: vi.fn(() => false),
}));

vi.mock('@/api/client/serializeAxiosErrorForLog', () => ({
    serializeAxiosErrorForLog: vi.fn(() => ({})),
}));

vi.mock('@/features/serverFeaturesClient', () => ({
    fetchServerFeaturesSnapshot: vi.fn(async () => ({
        status: 'unsupported',
        reason: 'endpoint_missing',
    })),
}));

vi.mock('@happier-dev/cli-common/tailscale', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/cli-common/tailscale')>(),
    runTailscaleStatusJson: vi.fn(async () => {
        throw new Error('tailscale unavailable in daemon test');
    }),
}));

vi.mock('@/rpc/handlers/registerSessionHandlers', () => ({
    resolveCanonicalCodexBackendMode: vi.fn(() => 'codex'),
}));

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
    ensureMachineRegistered: vi.fn(async ({ machineId }: { machineId: string }) => ({
        machineId,
        didRotateMachineId: false,
        machine: {
            id: machineId,
            metadata: {},
        },
    })),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: loggerDebug,
        debugLargeJson: vi.fn(),
        info: vi.fn(),
        infoFile: vi.fn(),
        warn: vi.fn(),
        flushSync: vi.fn(),
        logFilePath: '/tmp/happier-daemon.log',
    },
}));

vi.mock('@/ui/auth', () => ({
    authAndSetupMachineIfNeeded: vi.fn(async () => ({
        credentials: harness.credentials,
        machineId: 'machine-session-handoff',
    })),
}));

vi.mock('@/settings/accountSettings/updateAccountSettingsV2WithRetry', () => {
    let settings: Record<string, unknown> = {};
    let version = 0;
    const updateSettings = vi.fn(async (input: Readonly<{
        mutate?: (current: Readonly<Record<string, unknown>>) => Record<string, unknown>;
        mutation?: Readonly<{ operations: readonly Readonly<
            | { op: 'set'; key: string; value: unknown }
            | { op: 'reset'; key: string }
        >[] }>;
    }>) => {
        if (input.mutation) {
            const next = { ...settings };
            for (const operation of input.mutation.operations) {
                if (operation.op === 'set') next[operation.key] = operation.value;
                else delete next[operation.key];
            }
            settings = next;
        } else if (input.mutate) {
            settings = input.mutate(settings);
        } else {
            throw new Error('Expected Account Settings mutation');
        }
        version += 1;
        return { status: 'applied' as const, settings, version };
    });
    return {
        updateAccountSettingsV2WithRetry: updateSettings,
        updateAccountSettingsV2Once: updateSettings,
        requireAccountSettingsMutationSuccess: (result: Readonly<{ status?: unknown }>) => {
            if (result.status === 'applied' || result.status === 'satisfied' || result.status === 'unchanged') return result;
            throw new Error(`Account Settings mutation did not settle: ${String(result.status)}`);
        },
    };
});

vi.mock('@/configuration', () => ({
    configuration: {
        privateKeyFile: '/tmp/key',
        happyHomeDir: '/tmp/home',
        activeServerId: 'default',
        currentCliVersion: '0.0.0-test',
        publicReleaseRing: 'publicdev',
        serverUrl: 'https://api.happier.dev',
        apiServerUrl: 'https://api.happier.dev',
        webappUrl: 'https://happier.dev',
        activeServerDir: '/tmp/server',
        deviceLocalSecretKeyFile: '/tmp/home/device-local-secret.key',
        daemonSpawnExistingSessionWaitForExitMs: 5_000,
        daemonSpawnExistingSessionWaitForExitPollIntervalMs: 50,
    },
}));

vi.mock('@/integrations/caffeinate', () => ({
    startCaffeinate: vi.fn(() => false),
    stopCaffeinate: vi.fn(async () => {}),
}));

vi.mock('@/ui/doctor', () => ({
    getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/utils/spawnHappyCLI', () => ({
    buildHappyCliSubprocessInvocation: vi.fn(),
    buildHappyCliSubprocessLaunchSpec: vi.fn<BuildHappyCliSubprocessLaunchSpec>(),
    pruneHappyCliRunnerSnapshots: vi.fn(),
    spawnHappyCLI: vi.fn(),
}));

vi.mock('@/session/runtime/catalogHooks', () => ({
    getVendorResumeSupport: vi.fn(async () => () => true),
}));

vi.mock('@/agent/catalog/resolution', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/agent/catalog/resolution')>(),
    resolveAgentCliSubcommand: vi.fn(),
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    writeDaemonState: vi.fn(),
    writeDaemonStateForLockOwner: vi.fn(() => true),
    clearDaemonStateForLockOwner: vi.fn(() => true),
    clearDaemonStateForTestTeardown: vi.fn(async () => {}),
    acquireDaemonLock: vi.fn(async () => harness.lockHandle),
    releaseDaemonLock: vi.fn(async () => {}),
    readCredentials: vi.fn(async () => harness.credentials),
    readStoredCredentials: vi.fn(async () => harness.credentials),
}));

vi.mock('./controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('./controlClient')>(),
    cleanupDaemonState: vi.fn(async () => {}),
    isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(async () => false),
    stopDaemon: vi.fn(async () => {}),
}));

vi.mock('./controlServer', () => ({
    startDaemonControlServer: vi.fn(async () => ({
        port: 43210,
        stop: vi.fn(async () => {}),
    })),
}));

vi.mock('./sessions/reattachFromMarkers', () => ({
    reattachTrackedSessionsFromMarkers: vi.fn(async () => ({
        orphanedDeadDaemonSessions: [],
        connectedServiceRestartIntents: [],
    })),
}));

vi.mock('./sessions/onHappySessionWebhook', async (importOriginal) => ({
    ...await importOriginal<typeof import('./sessions/onHappySessionWebhook')>(),
    createOnHappySessionWebhook: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/onChildExited', () => ({
    createOnChildExited: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/visibleConsoleSpawnWaiter', () => ({
    waitForVisibleConsoleSessionWebhook: vi.fn(async () => null),
}));

vi.mock('./sessions/stopSession', () => ({
    createStopSession: vi.fn(() => vi.fn(async () => ({ status: 'stopped' as const }))),
}));

vi.mock('./sessions/resolveSpawnWebhookResult', () => ({
    resolveSpawnWebhookResult: vi.fn(({ result }) => result),
}));

vi.mock('./lifecycle/heartbeat', () => ({
    startDaemonHeartbeatLoop: vi.fn(() => setInterval(() => {}, 60_000)),
}));

vi.mock('@/projectPath', () => ({
    projectPath: vi.fn(() => '/tmp/project'),
}));

vi.mock('@/integrations/tmux', () => ({
    selectPreferredTmuxSessionName: vi.fn(),
    TmuxUtilities: {},
    isTmuxAvailable: vi.fn(() => false),
}));

vi.mock('@/terminal/runtime/terminalConfig', () => ({
    resolveTerminalRequestFromSpawnOptions: vi.fn(() => null),
}));

vi.mock('@/terminal/runtime/envVarSanitization', () => ({
    validateEnvVarRecordStrict: vi.fn(() => ({ ok: true, env: {} })),
}));

vi.mock('./machine/metadata', () => ({
    getPreferredHostName: vi.fn(async () => 'host.local'),
    initialMachineMetadata: {},
}));

vi.mock('./lifecycle/shutdown', () => ({
    createDaemonShutdownController: harness.createDaemonShutdownController,
}));

vi.mock('./platform/tmux/spawnConfig', () => ({
    buildTmuxSpawnConfig: vi.fn(),
    buildTmuxWindowEnv: vi.fn(),
}));

vi.mock('./platform/windows/windowsSessionConsoleMode', () => ({
    resolveWindowsRemoteSessionConsoleMode: vi.fn(),
}));

vi.mock('./platform/windows/spawnHappyCliVisibleConsole', () => ({
    startHappySessionInVisibleWindowsConsole: vi.fn(),
}));

vi.mock('./platform/windows/spawnHappyCliWindowsTerminal', () => ({
    startHappySessionInWindowsTerminal: vi.fn(),
}));

vi.mock('./platform/windows/windowsHostedSessionRuntime', () => ({
    buildWindowsHostedTerminalArgs: vi.fn(),
    buildWindowsHostedTerminalAttachment: vi.fn(),
    buildWindowsTerminalWindowIdentity: vi.fn(),
}));

vi.mock('./sessionSpawnArgs', () => ({
    buildHappySessionControlArgs: vi.fn(() => []),
}));

vi.mock('./startup/waitForAuthConfig', () => ({
    resolveWaitForAuthConfig: vi.fn(() => ({
        waitForAuthEnabled: false,
        waitForAuthTimeoutMs: 0,
    })),
}));

vi.mock('./startup/ensureSessionDirectory', () => ({
    ensureSessionDirectory: vi.fn(async () => ({ ok: true, directoryCreated: false })),
}));

vi.mock('@/daemon/ownership/evaluateCurrentDaemonOwner', () => ({
    evaluateCurrentDaemonOwner: vi.fn(async () => ({ kind: 'none' })),
}));

vi.mock('@/daemon/ownership/resolveDaemonTakeoverDecision', () => ({
    buildDaemonTakeoverNotice: vi.fn(() => ({ title: 'takeover', lines: [] })),
    resolveDaemonTakeoverDecision: vi.fn(() => ({ kind: 'ok' })),
}));

vi.mock('@/daemon/ownership/daemonServiceInventory', () => ({
    evaluateDaemonStartupServiceConflict: vi.fn(async () => ({ kind: 'ok' })),
    renderDaemonInstalledServiceConflict: vi.fn(() => ({ title: 'service-conflict', lines: [] })),
}));

vi.mock('./startup/waitForInitialCredentials', () => ({
    waitForInitialCredentials: vi.fn(async () => ({
        action: 'continue',
        daemonLockHandle: harness.lockHandle,
    })),
}));

vi.mock('./spawn/waitForSessionWebhook', () => ({
    waitForSessionWebhook: vi.fn(async () => null),
}));

vi.mock('./spawn/resolveSpawnChildEnvironment', () => ({
    resolveSpawnChildEnvironment: vi.fn(async () => ({ env: {} })),
}));

vi.mock('./automation/automationWorker', () => ({
    startAutomationWorker: harness.startAutomationWorker,
}));

vi.mock('./memory/memoryWorker', () => ({
    startMemoryWorker: vi.fn(async () => null),
}));

vi.mock('./voiceInference/voiceInferenceWorker', () => ({
    startVoiceInferenceWorker: vi.fn(async () => null),
}));

vi.mock('./connectedServices/resolveConnectedServiceAuthForSpawn', () => ({
    resolveConnectedServiceAuthForSpawn: vi.fn(async () => undefined),
}));

vi.mock('./connectedServices/shouldResolveConnectedServiceAuthForSpawn', () => ({
    shouldResolveConnectedServiceAuthForSpawn: vi.fn(() => false),
}));

vi.mock('./connectedServices/quotas/ConnectedServiceQuotasCoordinator', () => ({
    ConnectedServiceQuotasCoordinator: vi.fn(),
}));

vi.mock('./connectedServices/quotas/createConnectedServiceQuotaFetchers', () => ({
    createConnectedServiceQuotaFetchers: vi.fn(() => ({})),
}));

vi.mock('./connectedServices/quotas/resolveConnectedServiceQuotasDaemonOptions', () => ({
    resolveConnectedServiceQuotasDaemonOptions: vi.fn(() => ({
        fetchTimeoutMs: 1000,
        discoveryEnabled: false,
        discoveryIntervalMs: 1000,
        failureBackoffMinMs: 1000,
        failureBackoffMaxMs: 1000,
        failureBackoffJitterPct: 0,
    })),
}));

vi.mock('./connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled', () => ({
    resolveConnectedServicesQuotasDaemonEnabled: vi.fn(async () => false),
}));

vi.mock('./connectedServices/quotas/startConnectedServiceQuotasLoop', () => ({
    startConnectedServiceQuotasLoop: vi.fn(() => ({ stop: vi.fn(), pause: vi.fn(), resume: vi.fn() })),
}));

vi.mock('@/terminal/attachment/terminalAttachmentInfo', () => ({
    writeTerminalAttachmentInfo: vi.fn(async () => {}),
}));

vi.mock('./shutdownPolicy', () => ({
    getDaemonShutdownExitCode: vi.fn(() => 0),
    getDaemonShutdownWatchdogTimeoutMs: vi.fn(() => 10_000),
}));

vi.mock('@/machines/transfer/directPeerTransport', async () => {
    const actual = await vi.importActual<typeof import('@/machines/transfer/directPeerTransport')>('@/machines/transfer/directPeerTransport');
    return {
        ...actual,
        createDirectPeerTransferRegistry: vi.fn(() => harness.directPeerRegistry),
        requestDirectPeerTransferToFile: harness.requestDirectPeerTransferToFile,
        startDirectPeerTransferServer: vi.fn(async () => ({
            port: 46001,
            stop: vi.fn(async () => {}),
        })),
    };
});

let activeDaemonPromise: Promise<void> | null = null;

async function startDaemonForHandoffTest(): Promise<void> {
    const { startDaemon } = await import('./startDaemon');
    activeDaemonPromise = startDaemon();
    try {
        await vi.waitFor(() => {
            expect(harness.apiMachine.setRPCHandlers).toHaveBeenCalled();
        }, { timeout: 30_000 });
    } catch (error) {
        const fatalLog = loggerDebug.mock.calls.find(([message]) =>
            typeof message === 'string' && message.includes('[FATAL]'));
        if (fatalLog) {
            throw new Error(`Daemon startup failed: ${JSON.stringify(fatalLog[1])}`);
        }
        throw error;
    }
}

describe('startDaemon session handoff wiring (integration)', () => {
    beforeEach(() => {
        vi.resetModules();
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
        loggerDebug.mockClear();
    });

    afterEach(async () => {
        harness.requestShutdown('happier-cli');
        await activeDaemonPromise;
        activeDaemonPromise = null;
        vi.restoreAllMocks();
        harness.apiMachine.setRPCHandlers.mockClear();
        harness.directPeerRegistry.publishTransfer.mockClear();
        harness.directPeerRegistry.clearPublishedTransfer.mockClear();
        harness.requestDirectPeerTransferToFile.mockClear();
        delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED;
        delete process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED;
        delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT;
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
  });

  it('starts the direct peer HTTP server lazily on first publication instead of daemon boot', async () => {
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            await startDaemonForHandoffTest();

            const { startDirectPeerTransferServer } = await import('@/machines/transfer/directPeerTransport');
            expect(startDirectPeerTransferServer).toHaveBeenCalledTimes(0);

            const { directPeerTransfer } = requireRegisteredMachineRpcHandlers();
            expect(directPeerTransfer).toBeDefined();
            if (!directPeerTransfer) {
                throw new Error('Expected direct-peer transfer handlers');
            }
            expect(directPeerTransfer.requestPayloadFile).toEqual(expect.any(Function));

            const payloadSource = {
                kind: 'file' as const,
                filePath: '/tmp/handoff-payload.bin',
                sizeBytes: 123,
                manifestHash: 'sha256:test-manifest',
                dispose: vi.fn(async () => {}),
            };

            const endpointCandidates = await directPeerTransfer.publishTransfer({
                transferId: 'handoff_rns',
                payload: {
                    agentBundle: {
                        providerId: 'claude',
                        remoteSessionId: 'claude_session_source',
                        transcriptBase64: 'e30K',
                    },
                },
                payloadSource,
            });

            expect(startDirectPeerTransferServer).toHaveBeenCalledTimes(1);
            const startedArgs = (startDirectPeerTransferServer as unknown as { mock: { calls: unknown[][] } }).mock.calls.at(0)?.[0] as {
                resolveOnDemandTransfer?: (input: { transferId: string; transferToken: string; requestBody: unknown }) => Promise<unknown>;
            } | undefined;
            expect(startedArgs?.resolveOnDemandTransfer).toEqual(expect.any(Function));
            await startedArgs?.resolveOnDemandTransfer?.({ transferId: 'on-demand-1', transferToken: 'token_1', requestBody: { ok: true } });
            expect(harness.directPeerRegistry.resolveOnDemandTransferOnOpen).toHaveBeenCalledTimes(1);

            expect(harness.directPeerRegistry.publishTransfer).toHaveBeenCalledTimes(1);
            const publishedCall = harness.directPeerRegistry.publishTransfer.mock.calls.at(0);
            expect(publishedCall).toBeDefined();
            const [published] = publishedCall as unknown as readonly [{
                transferId: string;
                payloadSource: typeof payloadSource;
            }];
            expect(published.transferId).toBe('handoff_rns');
            expect(published.payloadSource).toBe(payloadSource);
            expect(endpointCandidates).toEqual([
                {
                    kind: 'http',
                    url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_1',
                    authorizationToken: 'token_1',
                    expiresAt: 30_000,
                },
            ]);
        } finally {
            await rm('/tmp/server/session-handoff/local-metadata', { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('does not start the direct peer HTTP server when direct peer local mode is disabled', async () => {
        process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED = 'false';
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        const { startDirectPeerTransferServer } = await import('@/machines/transfer/directPeerTransport');
        await startDaemonForHandoffTest();

        expect(startDirectPeerTransferServer).toHaveBeenCalledTimes(0);

        const { directPeerTransfer } = requireRegisteredMachineRpcHandlers();
        expect(directPeerTransfer).toBeUndefined();
    });

    it('does not start the direct peer HTTP server when the server feature is disabled', async () => {
        process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED = 'false';
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        const { startDirectPeerTransferServer } = await import('@/machines/transfer/directPeerTransport');
        await startDaemonForHandoffTest();

        expect(startDirectPeerTransferServer).toHaveBeenCalledTimes(0);

        const { directPeerTransfer } = requireRegisteredMachineRpcHandlers();
        expect(directPeerTransfer).toBeUndefined();
    });

    it('forwards timeoutMs through the daemon direct-peer requestPayloadFile bridge', async () => {
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        await startDaemonForHandoffTest();

        const { directPeerTransfer } = requireRegisteredMachineRpcHandlers();
        expect(directPeerTransfer?.requestPayloadFile).toEqual(expect.any(Function));
        if (!directPeerTransfer?.requestPayloadFile) {
            throw new Error('Expected direct-peer payload-file handler');
        }

        const endpointCandidates = [
            {
                kind: 'http' as const,
                url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_timeout_bridge',
                authorizationToken: 'token_timeout_bridge',
                expiresAt: 30_000,
            },
        ];

        await directPeerTransfer.requestPayloadFile({
            transferId: 'handoff_timeout_bridge',
            endpointCandidates,
            destinationPath: '/tmp/handoff-timeout-bridge.bin',
            timeoutMs: 23_456,
        });

        expect(harness.requestDirectPeerTransferToFile).toHaveBeenCalledWith({
            transferId: 'handoff_timeout_bridge',
            endpointCandidates,
            destinationPath: '/tmp/handoff-timeout-bridge.bin',
            timeoutMs: 23_456,
        });
    });

    it('wires a local session metadata loader for handoff-back starts', async () => {
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
            const { createLocalSessionHandoffMetadataStore } = await import('@/session/handoff/metadata/localSessionHandoffMetadataStore');
            type TrackedSessionRef = {
                startedBy: string;
                pid: number;
                happySessionId?: string;
                happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
                vendorResumeId?: string;
                spawnOptions?: Record<string, unknown>;
            };
            const trackedSessionCapture: { current: Map<number, TrackedSessionRef> | null } = { current: null };
            vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
                trackedSessionCapture.current = pidToTrackedSession as Map<number, TrackedSessionRef>;
                return vi.fn();
            });

            await startDaemonForHandoffTest();

            const { loadLocalSessionMetadata } = requireRegisteredMachineRpcHandlers();
            expect(loadLocalSessionMetadata).toEqual(expect.any(Function));
            if (!loadLocalSessionMetadata) {
                throw new Error('Expected local session metadata loader');
            }

            const trackedSessions = trackedSessionCapture.current;
            if (!trackedSessions) {
                throw new Error('Expected tracked session map from webhook wiring');
            }
            trackedSessions.set(1557, {
                startedBy: 'daemon',
                pid: 1557,
                happySessionId: 'sess_handoff_back',
                happySessionMetadataFromLocalWebhook: {
                    machineId: 'machine_target',
                    path: '/repo-source',
                    homeDir: '/Users/tester',
                    flavor: 'claude',
                    claudeSessionId: 'sess-handoff-direct',
                },
            });

            await expect(loadLocalSessionMetadata('sess_handoff_back')).resolves.toEqual(
                expect.objectContaining({
                    exportMetadata: expect.objectContaining({
                        machineId: 'machine_target',
                        path: '/repo-source',
                    }),
                    runtimeLocalMetadata: expect.objectContaining({
                        claudeSessionId: 'sess-handoff-direct',
                    }),
                }),
            );
            trackedSessions.set(2660, {
                startedBy: 'daemon',
                pid: 2660,
                happySessionId: 'sess_handoff_pre_webhook',
                vendorResumeId: 'sess-handoff-direct',
                spawnOptions: {
                    directory: '/repo-source-current',
                    backendTarget: {
                        kind: 'backend',
                        sourceKind: 'built_in',
                        backendId: 'claude',
                    },
                    transcriptStorage: 'direct',
                    environmentVariables: {
                        HOME: '/Users/target',
                        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
                    },
                },
            });
            const localSessionHandoffMetadataStore = createLocalSessionHandoffMetadataStore({
                activeServerDir: '/tmp/server',
            });
            await localSessionHandoffMetadataStore.saveByVendorResumeId({
                vendorResumeId: 'sess-handoff-direct',
                exportMetadataOverlay: {
                    handoffV1: {
                        v: 1,
                        sourceMachineId: 'machine_source',
                        targetMachineId: 'machine-session-handoff',
                        providerId: 'claude',
                        sessionStorageBefore: 'direct',
                        sessionStorageAfter: 'direct',
                        transportStrategy: 'direct_peer',
                        completedAtMs: 1,
                        sourceWorkspaceRootPath: '/repo-source-origin',
                        targetWorkspaceRootPath: '/repo-source-current',
                    },
                },
            });

            await expect(loadLocalSessionMetadata('sess_handoff_pre_webhook')).resolves.toEqual(
                expect.objectContaining({
                    exportMetadata: expect.objectContaining({
                        machineId: 'machine-session-handoff',
                        path: '/repo-source-current',
                        homeDir: '/Users/target',
                        flavor: 'claude',
                        handoffV1: expect.objectContaining({
                            sourceMachineId: 'machine_source',
                            targetMachineId: 'machine-session-handoff',
                            sourceWorkspaceRootPath: '/repo-source-origin',
                            targetWorkspaceRootPath: '/repo-source-current',
                        }),
                    }),
                    runtimeLocalMetadata: expect.objectContaining({
                        claudeSessionId: 'sess-handoff-direct',
                        externalSessionV1: expect.objectContaining({
                            remoteSessionId: 'sess-handoff-direct',
                            machineId: 'machine-session-handoff',
                            source: expect.objectContaining({
                                kind: 'claudeConfig',
                                configDir: '/tmp/claude-config',
                                projectId: '-repo-source-current',
                            }),
                        }),
                    }),
                }),
            );
            await expect(loadLocalSessionMetadata('missing_session')).resolves.toBeNull();
        } finally {
            harness.requestShutdown('happier-cli');
        }
    });

    it('loads persisted local handoff metadata via spawnOptions.resume when vendorResumeId is missing on the tracked session', async () => {
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
            const { createLocalSessionHandoffMetadataStore } = await import('@/session/handoff/metadata/localSessionHandoffMetadataStore');
            type TrackedSessionRef = {
                startedBy: string;
                pid: number;
                happySessionId?: string;
                happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
                vendorResumeId?: string;
                spawnOptions?: Record<string, unknown>;
            };
            const trackedSessionCapture: { current: Map<number, TrackedSessionRef> | null } = { current: null };
            vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
                trackedSessionCapture.current = pidToTrackedSession as Map<number, TrackedSessionRef>;
                return vi.fn();
            });

            await startDaemonForHandoffTest();

            const { loadLocalSessionMetadata } = requireRegisteredMachineRpcHandlers();
            expect(loadLocalSessionMetadata).toEqual(expect.any(Function));
            if (!loadLocalSessionMetadata) {
                throw new Error('Expected local session metadata loader');
            }

            const trackedSessions = trackedSessionCapture.current;
            if (!trackedSessions) {
                throw new Error('Expected tracked session map from webhook wiring');
            }
            trackedSessions.set(3661, {
                startedBy: 'daemon',
                pid: 3661,
                happySessionId: 'sess_handoff_resume_fallback',
                happySessionMetadataFromLocalWebhook: {
                    machineId: 'machine-session-handoff',
                    path: '/repo-source-current',
                    homeDir: '/Users/target',
                    flavor: 'claude',
                },
                spawnOptions: {
                    directory: '/repo-source-current',
                    backendTarget: {
                        kind: 'backend',
                        sourceKind: 'built_in',
                        backendId: 'claude',
                    },
                    resume: 'sess-handoff-direct-fallback',
                    transcriptStorage: 'direct',
                    environmentVariables: {
                        HOME: '/Users/target',
                        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
                    },
                },
            });
            const localSessionHandoffMetadataStore = createLocalSessionHandoffMetadataStore({
                activeServerDir: '/tmp/server',
            });
            await localSessionHandoffMetadataStore.saveByVendorResumeId({
                vendorResumeId: 'sess-handoff-direct-fallback',
                exportMetadataOverlay: {
                    handoffV1: {
                        v: 1,
                        sourceMachineId: 'machine_source',
                        targetMachineId: 'machine-session-handoff',
                        providerId: 'claude',
                        sessionStorageBefore: 'direct',
                        sessionStorageAfter: 'direct',
                        transportStrategy: 'direct_peer',
                        completedAtMs: 1,
                        sourceWorkspaceRootPath: '/repo-source-origin',
                        targetWorkspaceRootPath: '/repo-source-current',
                    },
                },
            });

            await expect(loadLocalSessionMetadata('sess_handoff_resume_fallback')).resolves.toEqual(
                expect.objectContaining({
                    exportMetadata: expect.objectContaining({
                        machineId: 'machine-session-handoff',
                        path: '/repo-source-current',
                        handoffV1: expect.objectContaining({
                            sourceMachineId: 'machine_source',
                            targetMachineId: 'machine-session-handoff',
                            sourceWorkspaceRootPath: '/repo-source-origin',
                            targetWorkspaceRootPath: '/repo-source-current',
                        }),
                    }),
                    runtimeLocalMetadata: expect.objectContaining({
                        claudeSessionId: 'sess-handoff-direct-fallback',
                        externalSessionV1: expect.objectContaining({
                            remoteSessionId: 'sess-handoff-direct-fallback',
                        }),
                    }),
                }),
            );
        } finally {
            harness.requestShutdown('happier-cli');
        }
    });

    it('loads persisted local handoff metadata even when the tracked session no longer has a webhook snapshot', async () => {
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
            const { createLocalSessionHandoffMetadataStore } = await import('@/session/handoff/metadata/localSessionHandoffMetadataStore');
            type TrackedSessionRef = {
                startedBy: string;
                pid: number;
                happySessionId?: string;
                happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
                vendorResumeId?: string;
                spawnOptions?: Record<string, unknown>;
            };
            const trackedSessionCapture: { current: Map<number, TrackedSessionRef> | null } = { current: null };
            vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
                trackedSessionCapture.current = pidToTrackedSession as Map<number, TrackedSessionRef>;
                return vi.fn();
            });

            await startDaemonForHandoffTest();

            const { loadLocalSessionMetadata } = requireRegisteredMachineRpcHandlers();
            expect(loadLocalSessionMetadata).toEqual(expect.any(Function));
            if (!loadLocalSessionMetadata) {
                throw new Error('Expected local session metadata loader');
            }

            const trackedSessions = trackedSessionCapture.current;
            if (!trackedSessions) {
                throw new Error('Expected tracked session map from webhook wiring');
            }
            trackedSessions.set(4662, {
                startedBy: 'daemon',
                pid: 4662,
                happySessionId: 'sess_handoff_overlay_only',
                vendorResumeId: 'sess-handoff-direct-overlay',
            });
            const localSessionHandoffMetadataStore = createLocalSessionHandoffMetadataStore({
                activeServerDir: '/tmp/server',
            });
            await localSessionHandoffMetadataStore.saveByVendorResumeId({
                vendorResumeId: 'sess-handoff-direct-overlay',
                exportMetadataOverlay: {
                    machineId: 'machine-session-handoff',
                    path: '/repo-source-current',
                    homeDir: '/Users/target',
                    flavor: 'claude',
                    handoffV1: {
                        v: 1,
                        sourceMachineId: 'machine_source',
                        targetMachineId: 'machine-session-handoff',
                        providerId: 'claude',
                        sessionStorageBefore: 'direct',
                        sessionStorageAfter: 'direct',
                        transportStrategy: 'direct_peer',
                        completedAtMs: 1,
                        sourceWorkspaceRootPath: '/repo-source-origin',
                        targetWorkspaceRootPath: '/repo-source-current',
                    },
                },
            });

            await expect(loadLocalSessionMetadata('sess_handoff_overlay_only')).resolves.toEqual(
                expect.objectContaining({
                    exportMetadata: expect.objectContaining({
                        machineId: 'machine-session-handoff',
                        path: '/repo-source-current',
                        homeDir: '/Users/target',
                        flavor: 'claude',
                        handoffV1: expect.objectContaining({
                            sourceMachineId: 'machine_source',
                            targetMachineId: 'machine-session-handoff',
                        }),
                    }),
                    runtimeLocalMetadata: expect.objectContaining({
                        claudeSessionId: 'sess-handoff-direct-overlay',
                    }),
                }),
            );
        } finally {
            harness.requestShutdown('happier-cli');
        }
    });

    it('loads persisted local handoff metadata when the tracked session is only identifiable by vendorResumeId', async () => {
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
            const { createLocalSessionHandoffMetadataStore } = await import('@/session/handoff/metadata/localSessionHandoffMetadataStore');
            type TrackedSessionRef = {
                startedBy: string;
                pid: number;
                happySessionId?: string;
                happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
                vendorResumeId?: string;
                spawnOptions?: Record<string, unknown>;
            };
            const trackedSessionCapture: { current: Map<number, TrackedSessionRef> | null } = { current: null };
            vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ pidToTrackedSession }) => {
                trackedSessionCapture.current = pidToTrackedSession as Map<number, TrackedSessionRef>;
                return vi.fn();
            });

            await startDaemonForHandoffTest();

            const { loadLocalSessionMetadata } = requireRegisteredMachineRpcHandlers();
            expect(loadLocalSessionMetadata).toEqual(expect.any(Function));
            if (!loadLocalSessionMetadata) {
                throw new Error('Expected local session metadata loader');
            }

            const trackedSessions = trackedSessionCapture.current;
            if (!trackedSessions) {
                throw new Error('Expected tracked session map from webhook wiring');
            }
            trackedSessions.set(5663, {
                startedBy: 'daemon',
                pid: 5663,
                vendorResumeId: 'sess-handoff-direct-vendor-only',
                spawnOptions: {
                    directory: '/repo-source-current',
                    backendTarget: {
                        kind: 'backend',
                        sourceKind: 'built_in',
                        backendId: 'claude',
                    },
                    resume: 'sess-handoff-direct-vendor-only',
                    transcriptStorage: 'direct',
                    environmentVariables: {
                        HOME: '/Users/target',
                        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
                    },
                },
            });
            const localSessionHandoffMetadataStore = createLocalSessionHandoffMetadataStore({
                activeServerDir: '/tmp/server',
            });
            await localSessionHandoffMetadataStore.saveByVendorResumeId({
                vendorResumeId: 'sess-handoff-direct-vendor-only',
                exportMetadataOverlay: {
                    machineId: 'machine-session-handoff',
                    path: '/repo-source-current',
                    homeDir: '/Users/target',
                    flavor: 'claude',
                    handoffV1: {
                        v: 1,
                        sourceMachineId: 'machine_source',
                        targetMachineId: 'machine-session-handoff',
                        providerId: 'claude',
                        sessionStorageBefore: 'direct',
                        sessionStorageAfter: 'direct',
                        transportStrategy: 'direct_peer',
                        completedAtMs: 1,
                        sourceWorkspaceRootPath: '/repo-source-origin',
                        targetWorkspaceRootPath: '/repo-source-current',
                    },
                },
            });

            await expect(loadLocalSessionMetadata('sess-handoff-direct-vendor-only')).resolves.toEqual(
                expect.objectContaining({
                    exportMetadata: expect.objectContaining({
                        machineId: 'machine-session-handoff',
                        path: '/repo-source-current',
                        homeDir: '/Users/target',
                        flavor: 'claude',
                    }),
                    runtimeLocalMetadata: expect.objectContaining({
                        claudeSessionId: 'sess-handoff-direct-vendor-only',
                    }),
                }),
            );
        } finally {
            harness.requestShutdown('happier-cli');
        }
    });

    it('fails closed when a direct-peer publish request omits the file-backed payload source', async () => {
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            await startDaemonForHandoffTest();

            const { directPeerTransfer } = requireRegisteredMachineRpcHandlers();
            expect(directPeerTransfer).toBeDefined();
            if (!directPeerTransfer) {
                throw new Error('Expected direct-peer transfer handlers');
            }

            await expect(directPeerTransfer.publishTransfer({
                transferId: 'handoff_missing_payload_source',
                payload: {
                    agentBundle: {
                        providerId: 'claude',
                        remoteSessionId: 'claude_session_source',
                        transcriptBase64: 'e30K',
                    },
                },
            })).rejects.toThrow('Direct peer handoff publish requires a file-backed payload source');
            expect(harness.directPeerRegistry.publishTransfer).not.toHaveBeenCalled();
        } finally {
            harness.requestShutdown('happier-cli');
        }
    });
});
