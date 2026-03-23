import { afterEach, describe, expect, it, vi } from 'vitest';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;

const harness = vi.hoisted(() => {
    let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
    let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;

        const directPeerRegistry = {
            publishTransfer: vi.fn(() => ({
                transferId: 'handoff_1',
                transferToken: 'token_1',
                endpointCandidates: [{ kind: 'http' as const, url: 'http://127.0.0.1:46001/machine-transfers/direct/handoff_1', authorizationToken: 'token_1', expiresAt: 30_000 }],
                expiresAt: 30_000,
            })),
        readPublishedTransfer: vi.fn(() => null),
        clearPublishedTransfer: vi.fn(),
    };
    const startAutomationWorker = vi.fn(() => ({
        stop: vi.fn(),
        refreshAssignments: vi.fn(async () => {}),
        handleServerUpdate: vi.fn(),
    }));
    const apiMachine = {
        setRPCHandlers: vi.fn(),
        onUpdate: vi.fn(),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn((params?: { onConnect?: () => void | Promise<void> }) => {
            void params?.onConnect?.();
            setTimeout(() => requestShutdownRef?.('happier-cli'), 0);
        }),
        callMachineRpc: vi.fn(async () => ({})),
        updateMachineMetadata: vi.fn(async () => {}),
        updateDaemonState: vi.fn(async () => {}),
        shutdown: vi.fn(),
        onMachineTransferEnvelope: vi.fn(() => () => {}),
        sendMachineTransferEnvelope: vi.fn(),
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
        startAutomationWorker,
        apiMachine,
        lockHandle,
        createDaemonShutdownController,
    };
});

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            machineSyncClient: () => harness.apiMachine,
        })),
    },
    isMachineContentPublicKeyMismatchError: vi.fn(() => false),
}));

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
    ensureMachineRegistered: vi.fn(async ({ machineId }: { machineId: string }) => ({
        machineId,
        machine: {
            id: machineId,
            metadata: {},
        },
    })),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        logFilePath: '/tmp/happier-daemon.log',
    },
}));

vi.mock('@/ui/auth', () => ({
    authAndSetupMachineIfNeeded: vi.fn(async () => ({
        credentials: { token: 'token-session-handoff', encryption: { publicKey: 'a', machineKey: 'b' } },
        machineId: 'machine-session-handoff',
    })),
}));

vi.mock('@/configuration', () => ({
    configuration: {
        privateKeyFile: '/tmp/key',
        happyHomeDir: '/tmp/home',
        currentCliVersion: '0.0.0-test',
        serverUrl: 'https://api.happier.dev',
        activeServerDir: '/tmp/server',
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
    spawnHappyCLI: vi.fn(),
}));

vi.mock('@/backends/catalog', () => ({
    AGENTS: {},
    getVendorResumeSupport: vi.fn(async () => () => true),
    requireCatalogEntry: vi.fn(),
    resolveAgentCliSubcommand: vi.fn(),
    resolveCatalogAgentId: vi.fn(() => 'codex'),
}));

vi.mock('@/persistence', () => ({
    writeDaemonState: vi.fn(),
    acquireDaemonLock: vi.fn(async () => harness.lockHandle),
    releaseDaemonLock: vi.fn(async () => {}),
    readCredentials: vi.fn(async () => null),
}));

vi.mock('./controlClient', () => ({
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
    reattachTrackedSessionsFromMarkers: vi.fn(async () => {}),
}));

vi.mock('./sessions/onHappySessionWebhook', () => ({
    createOnHappySessionWebhook: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/onChildExited', () => ({
    createOnChildExited: vi.fn(() => vi.fn()),
}));

vi.mock('./sessions/visibleConsoleSpawnWaiter', () => ({
    waitForVisibleConsoleSessionWebhook: vi.fn(async () => null),
}));

vi.mock('./sessions/stopSession', () => ({
    createStopSession: vi.fn(() => vi.fn(async () => ({ stopped: true }))),
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

vi.mock('./connectedServices/resolveConnectedServiceAuthForSpawn', () => ({
    resolveConnectedServiceAuthForSpawn: vi.fn(async () => undefined),
}));

vi.mock('./connectedServices/shouldResolveConnectedServiceAuthForSpawn', () => ({
    shouldResolveConnectedServiceAuthForSpawn: vi.fn(() => false),
}));

vi.mock('./connectedServices/refresh/ConnectedServiceRefreshCoordinator', () => ({
    ConnectedServiceRefreshCoordinator: vi.fn(),
}));

vi.mock('./connectedServices/refresh/createConnectedServicesAuthUpdatedRestartHandler', () => ({
    createConnectedServicesAuthUpdatedRestartHandler: vi.fn(),
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

vi.mock('@/agent/runtime/daemonInitialPrompt', () => ({
    HAPPIER_DAEMON_INITIAL_PROMPT_ENV_KEY: 'HAPPIER_DAEMON_INITIAL_PROMPT',
    normalizeDaemonInitialPrompt: vi.fn(() => null),
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
        startDirectPeerTransferServer: vi.fn(async () => ({
            port: 46001,
            stop: vi.fn(async () => {}),
        })),
    };
});

describe('startDaemon session handoff wiring (integration)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        harness.apiMachine.setRPCHandlers.mockClear();
        harness.directPeerRegistry.publishTransfer.mockClear();
        harness.directPeerRegistry.clearPublishedTransfer.mockClear();
    });

    it('forwards file-backed direct-peer publish requests into the daemon registry without inline fallback', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            const { startDaemon } = await import('./startDaemon');
            await startDaemon();

            const handlers = harness.apiMachine.setRPCHandlers.mock.calls[0]?.[0];
            expect(handlers?.directPeerTransfer).toBeDefined();
            expect(handlers?.directPeerTransfer.requestPayloadFile).toEqual(expect.any(Function));
            const payloadSource = {
                kind: 'file' as const,
                filePath: '/tmp/handoff-payload.bin',
                sizeBytes: 123,
                manifestHash: 'sha256:test-manifest',
                dispose: vi.fn(async () => {}),
            };

            const endpointCandidates = handlers.directPeerTransfer.publishTransfer({
                transferId: 'handoff_rns',
                payload: {
                    providerBundle: {
                        providerId: 'claude',
                        remoteSessionId: 'claude_session_source',
                        transcriptBase64: 'e30K',
                    },
                },
                payloadSource,
            });

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
            exitSpy.mockRestore();
        }
    });

    it('wires a local session metadata loader for handoff-back starts', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
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

            const { startDaemon } = await import('./startDaemon');
            await startDaemon();

            const handlers = harness.apiMachine.setRPCHandlers.mock.calls[0]?.[0] as {
                loadLocalSessionMetadata?: (sessionId: string) => Promise<unknown>;
            } | undefined;

            expect(handlers?.loadLocalSessionMetadata).toEqual(expect.any(Function));

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

            await expect(handlers?.loadLocalSessionMetadata?.('sess_handoff_back')).resolves.toEqual(
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
                        kind: 'builtInAgent',
                        agentId: 'claude',
                    },
                    transcriptStorage: 'direct',
                    environmentVariables: {
                        HOME: '/Users/target',
                        CLAUDE_CONFIG_DIR: '/tmp/claude-config',
                    },
                },
            });

            await expect(handlers?.loadLocalSessionMetadata?.('sess_handoff_pre_webhook')).resolves.toEqual(
                expect.objectContaining({
                    exportMetadata: expect.objectContaining({
                        machineId: 'machine-session-handoff',
                        path: '/repo-source-current',
                        homeDir: '/Users/target',
                        flavor: 'claude',
                    }),
                    runtimeLocalMetadata: expect.objectContaining({
                        claudeSessionId: 'sess-handoff-direct',
                        directSessionV1: expect.objectContaining({
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
            await expect(handlers?.loadLocalSessionMetadata?.('missing_session')).resolves.toBeNull();
        } finally {
            exitSpy.mockRestore();
        }
    });

    it('fails closed when a direct-peer publish request omits the file-backed payload source', async () => {
        const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            const { startDaemon } = await import('./startDaemon');
            await startDaemon();

            const handlers = harness.apiMachine.setRPCHandlers.mock.calls[0]?.[0];
            expect(handlers?.directPeerTransfer).toBeDefined();

            expect(() => handlers.directPeerTransfer.publishTransfer({
                transferId: 'handoff_missing_payload_source',
                payload: {
                    providerBundle: {
                        providerId: 'claude',
                        remoteSessionId: 'claude_session_source',
                        transcriptBase64: 'e30K',
                    },
                },
            })).toThrow('Direct peer handoff publish requires a file-backed payload source');
            expect(harness.directPeerRegistry.publishTransfer).not.toHaveBeenCalled();
        } finally {
            exitSpy.mockRestore();
        }
    });
});
