import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import axios from 'axios';
import type { ApiMachineClient } from '@/api/apiMachine';
import { legacyPidSessionTrackingKey, type SessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

type ShutdownSource = 'happier-app' | 'happier-cli' | 'os-signal' | 'exception';
type BuildHappyCliSubprocessLaunchSpec = typeof import('@/utils/spawnHappyCLI').buildHappyCliSubprocessLaunchSpec;
type MachineRpcHandlers = Parameters<ApiMachineClient['setRPCHandlers']>[0];
const loggerDebug = vi.hoisted(() => vi.fn());

const harness = vi.hoisted(() => {
    let resolveShutdown: ((value: { source: ShutdownSource; errorMessage?: string }) => void) | null = null;
    let requestShutdownRef: ((source: ShutdownSource, errorMessage?: string) => void) | null = null;
    const credentials = {
        token: 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2NvdW50LXNlc3Npb24taGFuZG9mZiJ9.',
        encryption: {
            type: 'dataKey' as const,
            publicKey: new Uint8Array(32).fill(1),
            machineKey: new Uint8Array(32).fill(2),
        },
    };
    let accountSettings: Record<string, unknown> = {
        workspaceRefsV1: [],
        workspaceSyncRelationshipsV1: [],
    };
    let accountSettingsVersion = 1;
    let accountSettingsScopeKey = 'unbound';
    const accountSettingsListeners = new Set<(previous: unknown, next: unknown) => void>();
    const createAccountSettingsSnapshot = () => ({
        source: 'network' as const,
        settings: accountSettings,
        settingsVersion: accountSettingsVersion,
        loadedAtMs: Date.now(),
        settingsSecretsReadKeys: [],
        scopeKey: accountSettingsScopeKey,
    });
    let accountSettingsSnapshot = createAccountSettingsSnapshot();
    const workspaceSyncCommands: unknown[] = [];
    const actionExecutorInputs: unknown[] = [];
    const workspaceSyncSidecars: Array<{ close(): Promise<void> }> = [];
    let controlServerInput: unknown = null;

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
        pause: vi.fn(async () => {}),
        resume: vi.fn(async () => {}),
        refreshAssignments: vi.fn(async () => {}),
        catchUp: vi.fn(async () => {}),
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
    let machineClientFactory: ((...args: readonly unknown[]) => unknown) | null = null;
    const machineSyncClient = vi.fn((...args: readonly unknown[]) => (
        machineClientFactory?.(...args) ?? apiMachine
    ));
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
        stopDirectPeerServer: vi.fn(async () => {}),
        requestDirectPeerTransferToFile: vi.fn(async ({ destinationPath }: { destinationPath: string }) => ({
            destinationPath,
            manifestHash: 'sha256:test-manifest',
            sizeBytes: 0,
        })),
        startAutomationWorker,
        apiMachine,
        machineSyncClient,
        setMachineClientFactory: (factory: ((...args: readonly unknown[]) => unknown) | null) => {
            machineClientFactory = factory;
        },
        lockHandle,
        createDaemonShutdownController,
        credentials,
        resetAccountSettings: () => {
            accountSettings = { workspaceRefsV1: [], workspaceSyncRelationshipsV1: [] };
            accountSettingsVersion = 1;
            accountSettingsScopeKey = 'unbound';
            accountSettingsSnapshot = createAccountSettingsSnapshot();
            accountSettingsListeners.clear();
            workspaceSyncCommands.length = 0;
            actionExecutorInputs.length = 0;
            controlServerInput = null;
        },
        bindAccountSettingsScope: (scopeKey: string) => {
            accountSettingsScopeKey = scopeKey;
            accountSettingsSnapshot = createAccountSettingsSnapshot();
        },
        captureControlServerInput: (input: unknown) => {
            controlServerInput = input;
        },
        readControlServerInput: () => controlServerInput,
        mutateAccountSettings: (mutate: (current: Readonly<Record<string, unknown>>) => Record<string, unknown>) => {
            const previous = accountSettingsSnapshot;
            accountSettings = mutate(accountSettings);
            accountSettingsVersion += 1;
            accountSettingsSnapshot = createAccountSettingsSnapshot();
            for (const listener of accountSettingsListeners) listener(previous, accountSettingsSnapshot);
            return { status: 'applied' as const, settings: accountSettings, version: accountSettingsVersion };
        },
        commitAccountSettings: (next: ReturnType<typeof createAccountSettingsSnapshot>) => {
            const previous = accountSettingsSnapshot;
            accountSettings = next.settings;
            accountSettingsVersion = next.settingsVersion;
            accountSettingsScopeKey = next.scopeKey ?? accountSettingsScopeKey;
            accountSettingsSnapshot = next;
            for (const listener of accountSettingsListeners) listener(previous, next);
            return { snapshot: next, didCommit: true };
        },
        readAccountSettings: () => accountSettingsSnapshot,
        subscribeAccountSettings: (listener: (previous: unknown, next: unknown) => void) => {
            accountSettingsListeners.add(listener);
            return () => accountSettingsListeners.delete(listener);
        },
        workspaceSyncCommands,
        actionExecutorInputs,
        workspaceSyncSidecars,
        requestShutdown: (source: ShutdownSource) => requestShutdownRef?.(source),
    };
});

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/session/actions/createCliActionExecutorFromCredentials')>();
    return {
        ...original,
        createCliActionExecutorFromCredentials: (input: unknown) => {
            harness.actionExecutorInputs.push(input);
            return original.createCliActionExecutorFromCredentials(input as never);
        },
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
            machineSyncClient: harness.machineSyncClient,
            setLocalMachineId: vi.fn(),
            setServerFeaturesSnapshotProvider: vi.fn(),
            setPeerMediationObservabilityRuntimeActionContextProvider: vi.fn(),
            createBrowserRuntimeActionExecutor: vi.fn(() => vi.fn()),
            getAccountEncryptionMode: vi.fn(async () => 'plain'),
            getConnectedServiceAuthGroup: vi.fn(async () => null),
        })),
    },
    isMachineContentPublicKeyMismatchError: vi.fn(() => false),
}));

vi.mock('@happier-dev/cli-common/firstPartyRuntime', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/cli-common/firstPartyRuntime')>(),
    resolveInstalledFirstPartyComponentPaths: vi.fn(() => ({
        currentPath: '/tmp/happier-mutagen-test-runtime',
        resolvedCurrentPath: '/tmp/happier-mutagen-test-runtime',
    })),
    assertMutagenEngineArtifactPayload: vi.fn(() => ({ engineVersion: 'test', protocolEpoch: 'test' })),
    resolveMutagenEngineArtifactPaths: vi.fn(() => ({
        managerPath: '/tmp/happier-mutagen-test-runtime/manager',
        agentPath: '/tmp/happier-mutagen-test-runtime/agent',
    })),
}));

// The native process-custody peer observer is the system boundary. Keep the
// production validator and broker authentication, supplying only the exact
// peer identity of this in-process sidecar testkit.
vi.mock('@/workspaces/sync/transport/workspaceSyncPeerIdentity', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/workspaces/sync/transport/workspaceSyncPeerIdentity')>();
    return {
        ...original,
        createWorkspaceSyncPeerIdentityValidator: () => original.createWorkspaceSyncPeerIdentityValidator({
            platform: process.platform,
            resolveExecutable: () => process.execPath,
            observe: async () => ({ pid: process.pid, uid: process.getuid?.() ?? 0 }),
            getUid: () => process.getuid?.() ?? 0,
        }),
    };
});

vi.mock('./startup/workspaceSyncNativeProcessLaunchers', async () => ({
    spawnWorkspaceSyncSidecar: vi.fn(async ({ inheritedBrokerDescriptor, onSpawned }: {
        inheritedBrokerDescriptor: Uint8Array;
        onSpawned?: (pid: number) => void;
    }) => {
        const descriptor = JSON.parse(Buffer.from(inheritedBrokerDescriptor).toString('utf8')) as {
            brokerEndpoint: string;
            brokerInstanceId: string;
            launchNonce: string;
            secret: string;
        };
        const { WorkspaceSyncBrokerClient } = await import('@/workspaces/sync/transport/workspaceSyncBrokerClient.testkit');
        const client = new WorkspaceSyncBrokerClient({
            endpointPath: descriptor.brokerEndpoint,
            brokerInstanceId: descriptor.brokerInstanceId,
            launchNonce: descriptor.launchNonce,
            launchSecret: Buffer.from(descriptor.secret, 'base64url'),
            sidecarPid: process.pid,
        });
        let session: Record<string, unknown> | null = null;
        client.onCommand((command) => {
            harness.workspaceSyncCommands.push(command);
            if (command.t === 'list') return { sessions: session ? [session] : [], nextCursor: null };
            if (command.t === 'create') {
                const definition = command.session;
                const endpoint = (value: string) => {
                    const parsed = new URL(value);
                    return { protocol: parsed.protocol.slice(0, -1), host: parsed.hostname, path: parsed.pathname, connected: true, scanned: true };
                };
                session = {
                    identifier: `mutagen-${definition.name}`,
                    name: definition.name,
                    labels: definition.labels,
                    alpha: endpoint(definition.alpha),
                    beta: endpoint(definition.beta),
                    mode: definition.mode,
                    paused: true,
                    status: 'disconnected',
                    successfulCycles: 0,
                    conflictCount: 0,
                };
                return session;
            }
            if (command.t === 'resume' && session) {
                session = { ...session, paused: false, status: 'watching' };
                return session;
            }
            if (command.t === 'flush' && session) {
                session = { ...session, successfulCycles: 1 };
                return session;
            }
            if (command.t === 'get') return session;
            if (command.t === 'terminate') {
                const terminated = session;
                session = null;
                return terminated;
            }
            if (command.t === 'shutdown') return {};
            throw new Error(`Unexpected Mutagen command in composed handoff test: ${command.t}`);
        });
        onSpawned?.(process.pid);
        await client.connectControl();
        harness.workspaceSyncSidecars.push(client);
        return {
            pid: process.pid,
            waitForTermination: async () => await new Promise<never>(() => undefined),
            stop: async () => await client.close(),
        };
    }),
    launchWorkspaceSyncLocalAgent: vi.fn(async () => ({
        stream: new PassThrough(),
        close: vi.fn(async () => {}),
    })),
    stopRetainedWorkspaceSyncNativeProcesses: vi.fn(async () => {}),
}));

vi.mock('@/api/client/serializeAxiosErrorForLog', () => ({
    serializeAxiosErrorForLog: vi.fn((error: unknown) => error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { value: String(error) }),
}));

// The concurrently generated GitHub manifest is currently invalid at catalog ingestion.
// Exclude only that unrelated plugin while retaining the production catalog/runtime and
// every Agent plugin needed by the handoff composition under test.
vi.mock('@/plugins/projection/registry/sources/generatedBundledPluginManifests', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/plugins/projection/registry/sources/generatedBundledPluginManifests')>();
    return {
        ...original,
        BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS: original.BUNDLED_FIRST_PARTY_PLUGIN_LOCATORS.filter(
            (locator) => locator.pluginId !== 'happier.scm.forge.github',
        ),
    };
});

vi.mock('@/api/changes', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/changes')>(),
    fetchChangesAccountId: vi.fn(async () => 'account-session-handoff'),
}));

vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>();
    const { createSessionRecordFixture } = await import('@/testkit/backends/sessionFixtures');
    const createSession = (sessionId: string) => createSessionRecordFixture({
        id: sessionId,
        machineId: 'machine-session-handoff',
        path: '/tmp/happier-handoff-composed-source',
        metadata: JSON.stringify({
            machineId: 'machine-session-handoff',
            path: '/tmp/happier-handoff-composed-source',
            flavor: 'claude',
            claudeSessionId: 'composed-claude-session',
        }),
        metadataLayoutVersion: 0,
        ownerMetadata: null,
        encryptionMode: 'plain',
    });
    return {
        ...original,
        fetchSessionById: vi.fn(async ({ sessionId }: { sessionId: string }) => createSession(sessionId)),
        fetchSessionByIdCompat: vi.fn(async ({ sessionId }: { sessionId: string }) => createSession(sessionId)),
    };
});

vi.mock('@/session/transport/rpc/sessionRpc', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/session/transport/rpc/sessionRpc')>(),
    callSessionRpc: vi.fn(async ({ method }: { method: string }) => (
        method.endsWith(':session.pendingQueue.wake.capability.get.v1')
            ? {
                ok: true as const,
                capability: 'pending_queue_wake_v1' as const,
                protocolVersion: 1 as const,
                method: 'session.pendingQueue.wake.v1' as const,
            }
            : method.endsWith(':session.pendingQueue.wake.v1')
                ? { ok: true as const, result: 'wake_published' as const }
                : { ok: false as const, errorCode: 'unsupported_test_session_rpc' }
    )),
}));

vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
    fetchAccountEncryptionCurrentness: vi.fn(async () => ({ mode: 'plain', version: 1 })),
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

vi.mock('@/rpc/handlers/registerSessionHandlers', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/rpc/handlers/registerSessionHandlers')>(),
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
        warn: (message: string, error?: unknown) => loggerDebug(
            message,
            error instanceof Error
                ? { name: error.name, message: error.message, stack: error.stack, code: (error as { code?: unknown }).code }
                : error,
        ),
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
    const updateSettings = vi.fn(async (input: Readonly<{
        mutate?: (current: Readonly<Record<string, unknown>>) => Record<string, unknown>;
        mutation?: Readonly<{ operations: readonly Readonly<
            | { op: 'set'; key: string; value: unknown }
            | { op: 'reset'; key: string }
        >[] }>;
    }>) => {
        return harness.mutateAccountSettings((settings) => {
            if (input.mutation) {
                const next = { ...settings };
                for (const operation of input.mutation.operations) {
                    if (operation.op === 'set') next[operation.key] = operation.value;
                    else delete next[operation.key];
                }
                return next;
            }
            if (input.mutate) return input.mutate(settings);
            throw new Error('Expected Account Settings mutation');
        });
    });
    return {
        updateAccountSettingsV2WithRetry: updateSettings,
        updateAccountSettingsV2Once: updateSettings,
        updateAccountSettingsV2OnceAgainstLatest: updateSettings,
        requireAccountSettingsMutationSuccess: (result: Readonly<{ status?: unknown }>) => {
            if (result.status === 'applied' || result.status === 'satisfied' || result.status === 'unchanged') return result;
            throw new Error(`Account Settings mutation did not settle: ${String(result.status)}`);
        },
    };
});

vi.mock('@/settings/accountSettings/activeAccountSettingsSnapshot', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/settings/accountSettings/activeAccountSettingsSnapshot')>(),
    commitActiveAccountSettingsSnapshot: vi.fn((next) => harness.commitAccountSettings(next)),
    getActiveAccountSettingsSnapshot: vi.fn(() => harness.readAccountSettings()),
    getActiveAccountSettingsSnapshotLifetimeToken: vi.fn(() => 1),
    subscribeActiveAccountSettingsSnapshot: vi.fn((listener: (previous: unknown, next: unknown) => void) => (
        harness.subscribeAccountSettings(listener)
    )),
}));

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
        installationIdentityFile: '/tmp/home/installation-identity.json',
        daemonSpawnExistingSessionWaitForExitMs: 5_000,
        daemonSpawnExistingSessionWaitForExitPollIntervalMs: 50,
    },
}));


vi.mock('@/ui/doctor', () => ({
    getEnvironmentInfo: vi.fn(() => ({})),
}));

vi.mock('@/utils/spawnHappyCLI', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/spawnHappyCLI')>(),
    buildHappyCliSubprocessInvocation: vi.fn((args: string[]) => ({
        runtime: 'node' as const,
        argv: ['/tmp/happier-runtime', ...args],
    })),
    buildHappyCliSubprocessLaunchSpec: vi.fn<BuildHappyCliSubprocessLaunchSpec>(),
    pruneHappyCliRunnerSnapshots: vi.fn(),
    spawnHappyCLI: vi.fn(() => ({
        pid: 12345,
        stdout: null,
        stderr: null,
        on: vi.fn(),
    })),
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
    // The daemon's external Action executor resolves its request-boundary
    // credentials through the server-scoped reader, not the ambient one. Leaving
    // this on the real on-disk store makes every loaded Action fail closed as
    // `not_authenticated` in the isolated harness.
    readStoredCredentialsForServerId: vi.fn(async () => harness.credentials),
}));

vi.mock('./controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('./controlClient')>(),
    cleanupDaemonState: vi.fn(async () => {}),
    isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(async () => false),
    resolveDaemonSpawnSessionByNonce: vi.fn(async () => ({
        status: 'success' as const,
        sessionId: 'c000000000000000000000000',
    })),
    stopDaemon: vi.fn(async () => {}),
}));

vi.mock('./controlServer', () => ({
    startDaemonControlServer: vi.fn(async (input: unknown) => {
        harness.captureControlServerInput(input);
        return {
        port: 43210,
        stop: vi.fn(async () => {}),
        };
    }),
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

vi.mock('./lifecycle/heartbeat', () => ({
    startDaemonHeartbeatLoop: vi.fn(() => setInterval(() => {}, 60_000)),
}));

vi.mock('@/projectPath', () => ({
    projectPath: vi.fn(() => fileURLToPath(new URL('../..', import.meta.url))),
}));

vi.mock('@/integrations/tmux', () => ({
    selectPreferredTmuxSessionName: vi.fn(),
    TmuxUtilities: {},
    isTmuxAvailable: vi.fn(() => false),
}));

vi.mock('@/terminal/runtime/terminalConfig', () => ({
    resolveTerminalRequestFromSpawnOptions: vi.fn(() => ({ requested: null })),
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
    waitForSessionWebhook: vi.fn(async () => ({
        type: 'success' as const,
        sessionId: 'c000000000000000000000000',
    })),
}));

vi.mock('./spawn/resolveSpawnChildEnvironment', () => ({
    resolveSpawnChildEnvironment: vi.fn(async () => ({
        ok: true as const,
        cleanupOnFailure: null,
        cleanupOnExit: null,
        expandedEnvironmentVariables: {},
        extraEnvForChild: {},
    })),
}));

vi.mock('./startup/executeSpawnSessionRequest', async (importOriginal) => {
    const original = await importOriginal<typeof import('./startup/executeSpawnSessionRequest')>();
    return {
        ...original,
        executeSpawnSessionRequest: async (...args: Parameters<typeof original.executeSpawnSessionRequest>) => {
            const result = await original.executeSpawnSessionRequest(...args);
            loggerDebug('[COMPOSED SPAWN RESULT]', result);
            return result;
        },
    };
});

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
    startConnectedServiceQuotasLoop: vi.fn(() => ({ stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), wake: vi.fn() })),
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
            stop: harness.stopDirectPeerServer,
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
            const cause = fatalLog[1];
            throw new Error(
                `Daemon startup failed: ${cause instanceof Error ? cause.stack ?? cause.message : JSON.stringify(cause)}`,
            );
        }
        throw error;
    }
}

describe('startDaemon session handoff wiring (integration)', () => {
    beforeEach(async () => {
        vi.resetModules();
        harness.setMachineClientFactory(null);
        harness.resetAccountSettings();
        const { resolveAccountSettingsScopeKey } = await import('@/settings/accountSettings/accountSettingsScopeKey');
        harness.bindAccountSettingsScope(resolveAccountSettingsScopeKey(harness.credentials));
        process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED = 'false';
        loggerDebug.mockClear();
    });

    afterEach(async () => {
        harness.requestShutdown('happier-cli');
        await activeDaemonPromise;
        activeDaemonPromise = null;
        vi.restoreAllMocks();
        harness.apiMachine.setRPCHandlers.mockClear();
        harness.machineSyncClient.mockClear();
        harness.setMachineClientFactory(null);
        harness.directPeerRegistry.publishTransfer.mockClear();
        harness.directPeerRegistry.clearPublishedTransfer.mockClear();
        harness.stopDirectPeerServer.mockClear();
        harness.apiMachine.awaitPendingRpcRequests.mockResolvedValue(undefined);
        harness.requestDirectPeerTransferToFile.mockClear();
        delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED;
        delete process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED;
        delete process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT;
        delete process.env.HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED;
  });

    it('enters session.handoff through the loaded daemon and reaches relationship and target authorities', async () => {
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        const sourcePath = '/tmp/happier-handoff-composed-source';
        const targetPath = '/tmp/happier-handoff-composed-target';
        const transcriptPath = `${sourcePath}/composed-claude-session.jsonl`;
        const mutagenRuntimePath = '/tmp/happier-mutagen-test-runtime';
        await mkdir(sourcePath, { recursive: true });
        await mkdir(targetPath, { recursive: true });
        await mkdir(mutagenRuntimePath, { recursive: true });
        await writeFile(transcriptPath, '{"type":"assistant","message":{"content":[]}}\n');
        await writeFile(`${mutagenRuntimePath}/manager`, 'boundary manager');
        await writeFile(`${mutagenRuntimePath}/agent`, 'boundary agent');
        vi.spyOn(axios, 'get').mockImplementation(async (url) => {
            if (String(url).endsWith('/v2/account/settings')) {
                const snapshot = harness.readAccountSettings();
                return {
                    status: 200,
                    data: { content: { t: 'plain', v: snapshot.settings }, version: snapshot.settingsVersion },
                } as never;
            }
            return { status: 401, data: {} } as never;
        });
        process.env.HAPPIER_E2E_FAKE_CLAUDE_LOG = transcriptPath;
        process.env.HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED = 'true';
        process.env.HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED = 'true';

        const composedClient: { current: ApiMachineClient | null } = { current: null };
        const composedConnection: { ready: boolean; error: unknown } = { ready: false, error: null };
        const { RpcHandlerManager } = await import('@/api/rpc/RpcHandlerManager');
        const productionMachineInvokeLocal = RpcHandlerManager.prototype.invokeLocal;
        vi.spyOn(RpcHandlerManager.prototype, 'invokeLocal').mockImplementation(async function (
            this: InstanceType<typeof RpcHandlerManager>,
            method,
            params,
            options,
        ) {
            try {
                const result = await productionMachineInvokeLocal.call(this, method, params, options);
                loggerDebug('[COMPOSED MACHINE RPC]', { method, params, result });
                return result;
            } catch (error) {
                loggerDebug('[COMPOSED MACHINE RPC]', { method, params, error });
                throw error;
            }
        });
        const { ApiMachineClient: ProductionApiMachineClient } = await import('@/api/apiMachine');
        const legacyMachineTransferSend = vi.spyOn(ProductionApiMachineClient.prototype, 'sendMachineTransferEnvelope');
        const userSocketRelaySend = vi.spyOn(ProductionApiMachineClient.prototype, 'sendTransferRelayV2Envelope');
        harness.setMachineClientFactory((machine, ownershipMetadata, lifecycleDependencies) => {
            const machineRecord = machine as Readonly<Record<string, unknown>>;
            let client: ApiMachineClient;
            try {
                client = new ProductionApiMachineClient(
                    harness.credentials.token,
                    { ...machineRecord, encryptionMode: 'plain' } as never,
                    ownershipMetadata as never,
                    lifecycleDependencies as never,
                );
            } catch (error) {
                loggerDebug('[COMPOSED CLIENT][ERROR]', error instanceof Error
                    ? { name: error.name, message: error.message, stack: error.stack }
                    : { value: String(error) });
                throw error;
            }
            const productionSetRpcHandlers = client.setRPCHandlers.bind(client);
            client.setRPCHandlers = vi.fn((handlers, deps) => productionSetRpcHandlers(handlers, deps));
            const productionLocalRpc = client.getPeerMediationMachineRpcHandlerManager();
            const productionInvokeLocal = productionLocalRpc.invokeLocal.bind(productionLocalRpc);
            vi.spyOn(productionLocalRpc, 'invokeLocal').mockImplementation(async (method, params, options) => {
                try {
                    const result = await productionInvokeLocal(method, params, options);
                    loggerDebug('[COMPOSED LOCAL RPC]', { method, params, result });
                    return result;
                } catch (error) {
                    loggerDebug('[COMPOSED LOCAL RPC]', { method, params, error });
                    throw error;
                }
            });
            client.getPeerMediationMachineRpcHandlerManager = vi.fn(() => productionLocalRpc);
            client.connect = vi.fn((params?: { onConnect?: () => void | Promise<void> }) => {
                void Promise.resolve(params?.onConnect?.())
                    .then(() => {
                        composedConnection.ready = true;
                    })
                    .catch((error: unknown) => {
                        composedConnection.error = error;
                        loggerDebug('[COMPOSED CONNECT][ERROR]', error instanceof Error
                            ? { name: error.name, message: error.message, stack: error.stack }
                            : { value: String(error) });
                    });
            });
            composedClient.current = client;
            return client;
        });

        try {
            const { startDaemon } = await import('./startDaemon');
            activeDaemonPromise = startDaemon();
            try {
                await vi.waitFor(() => {
                    expect(composedClient.current).not.toBeNull();
                    expect(vi.mocked(composedClient.current!.setRPCHandlers)).toHaveBeenCalledOnce();
                    if (composedConnection.error) throw composedConnection.error;
                    expect(composedConnection.ready).toBe(true);
                }, { timeout: 120_000 });
            } catch (error) {
                const fatalLog = loggerDebug.mock.calls.find(([message]) => (
                    typeof message === 'string' && message.includes('[FATAL]')
                ));
                if (fatalLog) {
                    throw new Error(`Daemon startup failed: ${JSON.stringify(fatalLog[1])}`);
                }
                throw new Error(`Daemon registration timed out: machineClients=${harness.machineSyncClient.mock.calls.length} workspaceCommands=${JSON.stringify(harness.workspaceSyncCommands)} logs=${JSON.stringify(loggerDebug.mock.calls.slice(-10))}`, { cause: error });
            }
            const machineClient = composedClient.current;
            if (!machineClient) throw new Error('Expected production ApiMachineClient from daemon composition');
            const { getSessionHostBridge } = await import('@/agent/runtime/bridges/session/SessionHostBridge');
            try {
                await vi.waitFor(async () => {
                    const runtime = await getSessionHostBridge()
                        .resolveCurrentExecutionSurfacesForCatalogAgent('claude');
                    expect(runtime?.executionSurfaces.handoff).not.toBeNull();
                }, { timeout: 10_000, interval: 250 });
            } catch (error) {
                const { resolveBackendEngineAdapterResolution } = await import('@/agent/runtime/registry/engineRegistry');
                const runtime = await getSessionHostBridge()
                    .resolveCurrentExecutionSurfacesForCatalogAgent('claude');
                const resolution = await resolveBackendEngineAdapterResolution('claude');
                throw new Error(`Claude handoff surface unavailable: ${JSON.stringify({
                    runtime,
                    resolution: resolution && {
                        backendId: resolution.backendId,
                        agentId: resolution.agentId,
                        runtimeOwner: resolution.runtimeOwner,
                        selectedSource: resolution.selectedSource,
                        diagnostics: resolution.diagnostics,
                    },
                })}`, { cause: error });
            }

            const { computeWorkspaceSyncPolicyDigest } = await import('@/workspaces/sync/workspaceSyncTypes');
            const policyInput = {
                v: 1 as const,
                selection: 'all_files' as const,
                extraIgnorePatterns: [],
                extraIncludePatterns: [],
            };
            const sessionId = 'c000000000000000000000000';
            const controlInput = harness.readControlServerInput() as Parameters<
                typeof import('./controlServer').startDaemonControlServer
            >[0] | null;
            const externalActionApi = controlInput?.externalActionApi;
            if (!externalActionApi) throw new Error('Expected production external Action ingress from daemon composition');
            try {
                await vi.waitFor(async () => {
                    await externalActionApi.executor.execute('session.handoff', {}, {
                        surface: 'api', authority: 'present_user', actionCaller: { kind: 'host' },
                    });
                    expect(harness.actionExecutorInputs.some((input) => Boolean(
                        (input as Record<string, unknown>).machineActionDirectTargetTransport,
                    ))).toBe(true);
                }, { timeout: 10_000, interval: 250 });
            } catch (error) {
                throw new Error(`Machine Action transport did not become ready: ${JSON.stringify(loggerDebug.mock.calls)}`, { cause: error });
            }
            let resolvedPublicTarget: unknown;
            try {
                resolvedPublicTarget = await externalActionApi.resolveTarget({
                    actionId: 'session.handoff',
                    target: { kind: 'session', sessionId },
                    currentMachineId: 'machine-session-handoff',
                });
            } catch (error) {
                throw new Error('Production external Action target resolution failed', { cause: error });
            }
            expect(resolvedPublicTarget).toEqual({ kind: 'session', sessionId });
            const { executeExternalAction } = await import('./externalActions/executeExternalAction');
            let actionTargetResolutionError: unknown;
            const handoffEnvelope = {
                v: 1 as const,
                target: { kind: 'session' as const, sessionId },
                requestId: 'composed-create-relationship-1',
                input: {
                    sessionId,
                    targetMachineId: 'machine-session-handoff',
                    targetPath,
                    targetSessionStorageMode: 'persisted' as const,
                    workspaceAction: {
                        kind: 'create_relationship' as const,
                        mode: 'keep_synced' as const,
                        contentPolicy: {
                            ...policyInput,
                            policyDigest: computeWorkspaceSyncPolicyDigest(policyInput),
                        },
                        flushBeforeCommit: true as const,
                    },
                },
            };
            const executeHandoffAction = (envelope: unknown = handoffEnvelope) => executeExternalAction({
                actionId: 'session.handoff',
                envelope,
                principal: { authority: 'present_user' },
                currentMachineId: 'machine-session-handoff',
                currentServerId: externalActionApi.currentServerId,
                resolveTarget: async (input) => {
                    try {
                        return await externalActionApi.resolveTarget(input);
                    } catch (error) {
                        actionTargetResolutionError = new Error(
                            `Production target resolver rejected ${JSON.stringify(input)}`,
                            { cause: error },
                        );
                        throw actionTargetResolutionError;
                    }
                },
                executor: externalActionApi.executor,
            });
            const readPlainExecution = (admission: Awaited<ReturnType<typeof executeHandoffAction>>) => {
                if (admission.kind !== 'response') {
                    throw new Error(`External Action admission failed: ${JSON.stringify(admission)}`);
                }
                if (admission.response.v !== 1) throw new Error('Expected plaintext external Action response');
                return admission.response.execution;
            };
            const admitted = await executeHandoffAction();
            const result = readPlainExecution(admitted);
            if (actionTargetResolutionError) throw actionTargetResolutionError;
            if (!result.ok) {
                throw new Error(`Public session.handoff failed: ${JSON.stringify(result)} localRpc=${JSON.stringify(
                    vi.mocked(machineClient.getPeerMediationMachineRpcHandlerManager).mock.calls,
                )} actionExecutors=${JSON.stringify(harness.actionExecutorInputs.map((input) => ({
                    machineActionDirectTargetTransport: Boolean((input as Record<string, unknown>).machineActionDirectTargetTransport),
                })))} logs=${JSON.stringify(loggerDebug.mock.calls.slice(-20))}`);
            }

            expect(result).toMatchObject({
                ok: true,
                result: {
                    workspace: {
                        kind: 'relationship',
                        created: true,
                    },
                },
            });
            const createCommandsBeforeReplay = harness.workspaceSyncCommands.filter((command) => (
                (command as Readonly<{ t: string }>).t === 'create'
            )).length;
            const sidecarsBeforeReplay = harness.workspaceSyncSidecars.length;
            const replayed = await executeHandoffAction();
            const replayResult = readPlainExecution(replayed);
            if (!replayResult.ok) {
                throw new Error(`Exact session.handoff replay failed: ${JSON.stringify(replayResult)} logs=${JSON.stringify(
                    loggerDebug.mock.calls.slice(-30),
                )}`);
            }
            expect(replayResult).toEqual(result);
            expect(harness.workspaceSyncCommands.filter((command) => (
                (command as Readonly<{ t: string }>).t === 'create'
            ))).toHaveLength(createCommandsBeforeReplay);
            expect(harness.workspaceSyncSidecars).toHaveLength(sidecarsBeforeReplay);

            const changedDefinition = await executeHandoffAction({
                ...handoffEnvelope,
                input: {
                    ...handoffEnvelope.input,
                    workspaceAction: {
                        ...handoffEnvelope.input.workspaceAction,
                        mode: 'mirror_exactly' as const,
                    },
                },
            });
            expect(changedDefinition).toMatchObject({
                kind: 'response',
                response: {
                    execution: {
                        ok: false,
                        errorCode: 'action_request_input_conflict',
                    },
                },
            });
            expect(harness.workspaceSyncCommands.filter((command) => (
                (command as Readonly<{ t: string }>).t === 'create'
            ))).toHaveLength(createCommandsBeforeReplay);
            expect(harness.workspaceSyncSidecars).toHaveLength(sidecarsBeforeReplay);
            expect(harness.readAccountSettings().settings.workspaceRefsV1).toEqual([
                expect.objectContaining({ machineId: 'machine-session-handoff', rootPath: sourcePath }),
                expect.objectContaining({ machineId: 'machine-session-handoff', rootPath: targetPath }),
            ]);
            expect(harness.workspaceSyncCommands.map((command) => (
                command as Readonly<{ t: string }>
            ).t)).toEqual(expect.arrayContaining(['list', 'create', 'resume', 'flush']));
            expect(harness.apiMachine.setRPCHandlers).not.toHaveBeenCalled();
            expect(legacyMachineTransferSend).not.toHaveBeenCalled();
            expect(userSocketRelaySend).not.toHaveBeenCalled();
        } finally {
            delete process.env.HAPPIER_E2E_FAKE_CLAUDE_LOG;
            await rm(sourcePath, { recursive: true, force: true });
            await rm(targetPath, { recursive: true, force: true });
        }
    }, 360_000);

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
            type TrackedSessionRef = {
                trackingKey: SessionTrackingKey;
                startedBy: string;
                pid: number;
                happySessionId?: string;
                happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
                vendorResumeId?: string;
                spawnOptions?: Record<string, unknown>;
            };
            const trackedSessionCapture: { current: Map<SessionTrackingKey, TrackedSessionRef> | null } = { current: null };
            vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ trackedSessionsByKey }) => {
                trackedSessionCapture.current = trackedSessionsByKey as Map<SessionTrackingKey, TrackedSessionRef>;
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
            trackedSessions.set(legacyPidSessionTrackingKey(1557), {
                trackingKey: legacyPidSessionTrackingKey(1557),
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

            await expect(loadLocalSessionMetadata('  sess_handoff_back\n')).resolves.toEqual(
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
            trackedSessions.set(legacyPidSessionTrackingKey(2660), {
                trackingKey: legacyPidSessionTrackingKey(2660),
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
            const preWebhookMetadata = await loadLocalSessionMetadata('sess_handoff_pre_webhook');
            expect(preWebhookMetadata).toEqual(
                expect.objectContaining({
                    exportMetadata: expect.objectContaining({
                        machineId: 'machine-session-handoff',
                        path: '/repo-source-current',
                        homeDir: '/Users/target',
                        flavor: 'claude',
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
            expect(preWebhookMetadata?.exportMetadata).not.toHaveProperty('handoffV1');
            await expect(loadLocalSessionMetadata('missing_session')).resolves.toBeNull();
        } finally {
            harness.requestShutdown('happier-cli');
        }
    });

    it('uses current tracked metadata via spawnOptions.resume when vendorResumeId is missing', async () => {
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
            type TrackedSessionRef = {
                trackingKey: SessionTrackingKey;
                startedBy: string;
                pid: number;
                happySessionId?: string;
                happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
                vendorResumeId?: string;
                spawnOptions?: Record<string, unknown>;
            };
            const trackedSessionCapture: { current: Map<SessionTrackingKey, TrackedSessionRef> | null } = { current: null };
            vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ trackedSessionsByKey }) => {
                trackedSessionCapture.current = trackedSessionsByKey as Map<SessionTrackingKey, TrackedSessionRef>;
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
            trackedSessions.set(legacyPidSessionTrackingKey(3661), {
                trackingKey: legacyPidSessionTrackingKey(3661),
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
            const resumedMetadata = await loadLocalSessionMetadata('sess_handoff_resume_fallback');
            expect(resumedMetadata).toEqual(
                expect.objectContaining({
                    exportMetadata: expect.objectContaining({
                        machineId: 'machine-session-handoff',
                        path: '/repo-source-current',
                    }),
                    runtimeLocalMetadata: expect.objectContaining({
                        claudeSessionId: 'sess-handoff-direct-fallback',
                        externalSessionV1: expect.objectContaining({
                            remoteSessionId: 'sess-handoff-direct-fallback',
                        }),
                    }),
                }),
            );
            expect(resumedMetadata?.exportMetadata).not.toHaveProperty('handoffV1');
        } finally {
            harness.requestShutdown('happier-cli');
        }
    });

    it('does not revive retired metadata when the tracked session has no current metadata', async () => {
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
            type TrackedSessionRef = {
                trackingKey: SessionTrackingKey;
                startedBy: string;
                pid: number;
                happySessionId?: string;
                happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
                vendorResumeId?: string;
                spawnOptions?: Record<string, unknown>;
            };
            const trackedSessionCapture: { current: Map<SessionTrackingKey, TrackedSessionRef> | null } = { current: null };
            vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ trackedSessionsByKey }) => {
                trackedSessionCapture.current = trackedSessionsByKey as Map<SessionTrackingKey, TrackedSessionRef>;
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
            trackedSessions.set(legacyPidSessionTrackingKey(4662), {
                trackingKey: legacyPidSessionTrackingKey(4662),
                startedBy: 'daemon',
                pid: 4662,
                happySessionId: 'sess_handoff_overlay_only',
                vendorResumeId: 'sess-handoff-direct-overlay',
            });
            await expect(loadLocalSessionMetadata('sess_handoff_overlay_only')).resolves.toBeNull();
        } finally {
            harness.requestShutdown('happier-cli');
        }
    });

    it('matches an opaque vendor-only handoff id exactly without trimming it', async () => {
        vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

        try {
            const onHappySessionWebhookModule = await import('./sessions/onHappySessionWebhook');
            type TrackedSessionRef = {
                trackingKey: SessionTrackingKey;
                startedBy: string;
                pid: number;
                happySessionId?: string;
                happySessionMetadataFromLocalWebhook?: Record<string, unknown>;
                vendorResumeId?: string;
                spawnOptions?: Record<string, unknown>;
            };
            const trackedSessionCapture: { current: Map<SessionTrackingKey, TrackedSessionRef> | null } = { current: null };
            vi.mocked(onHappySessionWebhookModule.createOnHappySessionWebhook).mockImplementation(({ trackedSessionsByKey }) => {
                trackedSessionCapture.current = trackedSessionsByKey as Map<SessionTrackingKey, TrackedSessionRef>;
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
            const opaqueVendorResumeId = ' sess-handoff-direct-vendor-only\n';
            trackedSessions.set(legacyPidSessionTrackingKey(5663), {
                trackingKey: legacyPidSessionTrackingKey(5663),
                startedBy: 'daemon',
                pid: 5663,
                vendorResumeId: opaqueVendorResumeId,
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
            await expect(loadLocalSessionMetadata(opaqueVendorResumeId)).resolves.toEqual(
                expect.objectContaining({
                    exportMetadata: expect.objectContaining({
                        machineId: 'machine-session-handoff',
                        path: '/repo-source-current',
                        homeDir: '/Users/target',
                        flavor: 'claude',
                    }),
                }),
            );
            await expect(loadLocalSessionMetadata(opaqueVendorResumeId.trim())).resolves.toBeNull();
            await expect(loadLocalSessionMetadata(' \n\t ')).resolves.toBeNull();
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
