import { describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import {
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    FeaturesResponseSchema,
    type MachineLiveStreamRelayEnvelopeV1,
    type FeaturesResponse,
    type PeerLoopbackEndpointCandidateV1,
    type PeerTcpTunnelRelayEnvelope,
} from '@happier-dev/protocol';
import type { ManagedConnectionState, ManagedConnectionPhase } from '@happier-dev/connection-supervisor';

const usageLimitRecoveryMutationCustodyMocks = vi.hoisted(() => ({
    bindRecoveredJournals: vi.fn(async () => ({
        boundSessionIds: [],
        retainedSessionIds: [],
    })),
    close: vi.fn(async () => undefined),
    stage: vi.fn(async () => undefined),
}));

vi.mock('../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody', () => ({
    createDaemonUsageLimitRecoveryMutationCustody: vi.fn(() => usageLimitRecoveryMutationCustodyMocks),
}));

import type { DaemonState, Machine } from '@/api/types';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import { DEFAULT_MEMORY_SETTINGS } from '@/settings/memorySettings';

import { buildUnavailableMemoryEmbeddingsDiagnostics } from '../memory/resolveOperationalMemoryEmbeddingsSettings';
import type { MemoryWorkerHandle } from '../memory/memoryWorker';
import type { AutomationWorkerHandle } from '../automation/automationWorker';
import type { VoiceInferenceWorkerHandle } from '../voiceInference/voiceInferenceWorker';

import { bootstrapMachineSyncRuntime } from './bootstrapMachineSyncRuntime';
import type {
    BootstrapMachineSyncRuntimeParams,
    BootstrapMachineSyncRuntimeResult,
} from './bootstrapMachineSyncRuntime';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { createDeferred } from '@/testkit/async/deferred';

type ConnectedApiMachineForBootstrap = NonNullable<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>;

function createManagedConnectionState(phase: ManagedConnectionPhase): ManagedConnectionState {
    return {
        phase,
        reason: phase === 'online' ? null : 'transport_disconnect',
        attempt: 1,
        nextRetryAt: null,
        lastConnectedAt: phase === 'online' ? 1_000 : null,
        lastDisconnectedAt: phase === 'online' ? null : 1_000,
        lastErrorMessage: null,
    };
}

function requireManagedConnectionStateListener(
    listener: ((state: ManagedConnectionState) => void) | null,
): (state: ManagedConnectionState) => void {
    if (!listener) throw new Error('expected machine connection state listener');
    return listener;
}

function createVoiceInferenceWorkerHandle(): VoiceInferenceWorkerHandle {
    return {
        stop: vi.fn(async () => {}),
        getStatus: vi.fn(async () => ({
            serviceState: 'ready' as const,
            normalization: {
                inputTransport: 'upload_transfer' as const,
                strategy: 'daemon_decode' as const,
                systemFfmpegAllowed: false as const,
            },
            models: [],
        })),
        listModels: vi.fn(async () => []),
        getModelsStatus: vi.fn(async () => []),
        warmModelPack: vi.fn(async () => {}),
        installModel: vi.fn(async () => ({
            packId: 'stt-pack',
            pluginIdentity: null,
            kind: 'stt_sherpa' as const,
            model: 'sherpa',
            version: '1',
            executionSupport: ['daemon' as const],
            installState: 'installed' as const,
            progress: null,
            lastError: null,
            updatedAtMs: 0,
        })),
        acceptModelPackLicense: vi.fn(async () => ({
            packId: 'stt-pack',
            pluginIdentity: null,
            kind: 'stt_sherpa' as const,
            model: 'sherpa',
            version: '1',
            executionSupport: ['daemon' as const],
            installState: 'installed' as const,
            progress: null,
            lastError: null,
            updatedAtMs: 0,
        })),
        removeModel: vi.fn(async () => {}),
        synthesizeTts: vi.fn(async () => ({
            requestId: 'tts-1',
            output: { codec: 'wav', mimeType: 'audio/wav' } as const,
            filePath: '/tmp/fake.wav',
            sizeBytes: 4,
            name: 'fake.wav',
        })),
        cancelTts: vi.fn(async () => {}),
        transcribeAudio: vi.fn(async () => ({
            requestId: 'stt-1',
            text: 'hello',
            language: 'en',
            modelPackId: 'stt-pack',
        })),
        createStreamingTranscriptionSession: vi.fn(async () => {
            throw Object.assign(new Error('streaming runtime unavailable'), { code: 'runtime_unavailable' });
        }),
        cancelStt: vi.fn(async () => {}),
    };
}

function createPeerMediationServerFeatures(options: Readonly<{
    rpcDirectPeerEnabled?: boolean;
    tunnelDirectPeerEnabled?: boolean;
    tunnelServerRoutedEnabled?: boolean;
    liveStreamDirectPeerEnabled?: boolean;
}> = {}): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            machines: {
                enabled: true,
                rpc: {
                    enabled: true,
                    directPeer: { enabled: options.rpcDirectPeerEnabled ?? true },
                },
                tunnel: {
                    enabled: true,
                    directPeer: { enabled: options.tunnelDirectPeerEnabled ?? false },
                    serverRouted: { enabled: options.tunnelServerRoutedEnabled ?? false },
                },
                liveStream: {
                    enabled: true,
                    directPeer: { enabled: options.liveStreamDirectPeerEnabled ?? false },
                },
            },
        },
        capabilities: {
            machines: {
                peerMediation: {
                    grantSigningKeys: [{
                        keyId: 'grant-key-1',
                        publicKey: 'grant-public-key-1',
                        expiresAt: 602_000,
                    }],
                },
            },
        },
    });
}

function createProviderServerFeatures(enabled: boolean): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            providers: {
                enabled,
                localDiscovery: { enabled },
                localModelManagement: { enabled },
            },
        },
        capabilities: {},
    });
}

describe('bootstrapMachineSyncRuntime', () => {
    it('does not start automation or memory workers when machine sync is disabled', async () => {
        const startAutomationWorkerForMachine = vi.fn((): AutomationWorkerHandle => ({
            stop: vi.fn(),
            refreshAssignments: vi.fn(async () => {}),
            pause: vi.fn(),
            resume: vi.fn(),
            handleServerUpdate: vi.fn(),
        }));
        const memoryWorker: MemoryWorkerHandle = {
            stop: vi.fn(),
            reloadSettings: vi.fn(async () => {}),
            ensureUpToDate: vi.fn(async () => {}),
            getSettings: vi.fn(() => DEFAULT_MEMORY_SETTINGS),
            getEmbeddingsDiagnostics: vi.fn(() =>
                buildUnavailableMemoryEmbeddingsDiagnostics(DEFAULT_MEMORY_SETTINGS.embeddings),
            ),
            getWorkerStatus: vi.fn(() => ({
                state: 'idle' as const,
                lastTickAtMs: null,
                lastInventoryAtMs: null,
                currentSessionId: null,
                currentPhase: null,
            })),
            getTier1DbPath: vi.fn(() => null),
            getDeepDbPath: vi.fn(() => null),
        };
        const startMemoryWorkerForMachine = vi.fn(async (): Promise<MemoryWorkerHandle> => memoryWorker);
        const startVoiceInferenceWorkerForMachine = vi.fn(async (): Promise<VoiceInferenceWorkerHandle | null> => null);
        const createConnectedApiMachine = vi.fn(() => null);
        const attachTransferRuntimeStatePublisher = vi.fn(async () => {});
        const machine: Machine = {
            id: 'machine-disabled',
            encryptionKey: new Uint8Array(),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 0,
        };

        const result = await bootstrapMachineSyncRuntime({
            cliVersion: '0.0.0-test',
            machineId: 'machine-disabled',
            machine,
            preferredHost: 'host.local',
            happyHomeDir: '/tmp/happy-home',
            happyLibDir: '/tmp/happy-lib',
            filesystemAccessPolicy: { kind: 'osUser' },
            takeoverRequested: false,
            isShuttingDown: () => false,
            createConnectedApiMachine,
            attachTransferRuntimeStatePublisher,
            startAutomationWorkerForMachine,
            startMemoryWorkerForMachine,
            spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess-1' })),
            stopSession: vi.fn(async () => true),
            isSessionAlreadyRunning: vi.fn(async () => false),
            loadLocalSessionMetadataForHandoff: vi.fn(async () => null),
            savePreparedTargetLocalMetadata: vi.fn(async () => {}),
            beforeShutdown: vi.fn(async () => {}),
            requestShutdown: vi.fn(),
            directPeerServerLifecycle: null,
            directTransferPromptAssetAdapterRegistry: createPromptAssetAdapterRegistry(),
            directTransferPromptRegistryRegistry: createPromptRegistryAdapterRegistry(),
            connectedServiceRefreshLoopHandle: null,
            connectedServiceQuotasLoopHandle: null,
            daemonServerWorkScheduler: {} as never,
            startVoiceInferenceWorkerForMachine,
        });

        expect(createConnectedApiMachine).toHaveBeenCalledTimes(1);
        expect(attachTransferRuntimeStatePublisher).not.toHaveBeenCalled();
        expect(startAutomationWorkerForMachine).not.toHaveBeenCalled();
        expect(startMemoryWorkerForMachine).not.toHaveBeenCalled();
        expect(result).toEqual({
            apiMachine: null,
            apiMachineForSessions: null,
            automationWorker: null,
            memoryWorker: null,
            voiceInferenceWorker: null,
            daemonConnectivityCoordinator: null,
            daemonUsageLimitRecoveryMutationCustody: null,
            machineConnectionStateCleanup: null,
            stopPeerMediationLoopbackServer: expect.any(Function),
            resumeMachineConnectionPublications: expect.any(Function),
        });
    });

    it('updates server-work connectivity and rebinds retained usage custody on every online transition', async () => {
        usageLimitRecoveryMutationCustodyMocks.bindRecoveredJournals.mockClear();
        let quiescing = false;
        let connectionStateListener: ((state: ManagedConnectionState) => void) | null = null;
        const pauseExternalSessionPassiveFollow = vi.fn(async () => {});
        const resumeExternalSessionPassiveFollow = vi.fn(async () => {});
        const fakeConnectedApiMachine = {
            setRPCHandlers: vi.fn(() => ({
                connectivityResources: [{
                    name: 'externalSessionPassiveFollow',
                    pause: pauseExternalSessionPassiveFollow,
                    resume: resumeExternalSessionPassiveFollow,
                }],
            })),
            registerLiveStreamRelayRoutes: vi.fn(),
            onUpdate: vi.fn(() => () => {}),
            onAccountSettingsVersionHint: vi.fn(() => () => {}),
            onPendingSessionActivationHint: vi.fn(() => () => {}),
            onConnectionStateChange: vi.fn((listener: (state: ManagedConnectionState) => void) => {
                connectionStateListener = listener;
                return () => {};
            }),
            connect: vi.fn(),
            updateDaemonState: vi.fn(async () => {}),
            updateMachineMetadata: vi.fn(async () => {}),
            emitExternalSessionTranscriptUpdate: vi.fn(),
            onMachineTransferEnvelope: vi.fn(() => () => {}),
            sendMachineTransferEnvelope: vi.fn(),
            onTransferRelayV2Envelope: vi.fn(() => () => {}),
            sendTransferRelayV2Envelope: vi.fn(),
            onMachineLiveStreamRelayEnvelope: vi.fn(() => () => {}),
            sendMachineLiveStreamRelayEnvelope: vi.fn(),
            getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
                invokeLocal: async () => ({ ok: true }),
            })),
        };
        // Test harness boundary: bootstrap accepts the concrete ApiMachineClient class, so this fixture supplies only methods the bootstrap path calls.
        const connectedApiMachine = fakeConnectedApiMachine as unknown as ConnectedApiMachineForBootstrap;
        const setDaemonServerWorkOnline = vi.fn();
        const onMachineConnectionOnline = vi.fn(async () => {});
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 1,
        };

        const params = {
            cliVersion: '0.0.0-test',
            machineId: 'machine-1',
            machine,
            credentials: {
                token: 'token',
                encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
            },
            preferredHost: 'host.local',
            happyHomeDir: '/tmp/happy-home',
            happyLibDir: '/tmp/happy-lib',
            filesystemAccessPolicy: { kind: 'osUser' as const },
            takeoverRequested: false,
            isShuttingDown: () => quiescing,
            createConnectedApiMachine: vi.fn(() => connectedApiMachine),
            attachTransferRuntimeStatePublisher: vi.fn(async () => {}),
            startAutomationWorkerForMachine: vi.fn((): AutomationWorkerHandle => ({
                stop: vi.fn(),
                refreshAssignments: vi.fn(async () => {}),
                pause: vi.fn(),
                resume: vi.fn(),
                handleServerUpdate: vi.fn(),
            })),
            startMemoryWorkerForMachine: vi.fn(async (): Promise<MemoryWorkerHandle | null> => null),
            spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess-1' })),
            stopSession: vi.fn(async () => true),
            isSessionAlreadyRunning: vi.fn(async () => false),
            loadLocalSessionMetadataForHandoff: vi.fn(async () => null),
            savePreparedTargetLocalMetadata: vi.fn(async () => {}),
            beforeShutdown: vi.fn(async () => {}),
            requestShutdown: vi.fn(),
            directPeerServerLifecycle: null,
            directTransferPromptAssetAdapterRegistry: createPromptAssetAdapterRegistry(),
            directTransferPromptRegistryRegistry: createPromptRegistryAdapterRegistry(),
            connectedServiceRefreshLoopHandle: null,
            connectedServiceQuotasLoopHandle: null,
            daemonServerWorkScheduler: {} as never,
            startVoiceInferenceWorkerForMachine: vi.fn(async (): Promise<VoiceInferenceWorkerHandle | null> => null),
        } satisfies BootstrapMachineSyncRuntimeParams;

        await bootstrapMachineSyncRuntime(Object.assign(params, {
            setDaemonServerWorkOnline,
            onMachineConnectionOnline,
        }));

        const applyConnectionState = requireManagedConnectionStateListener(connectionStateListener);
        expect(applyConnectionState).toEqual(expect.any(Function));
        applyConnectionState(createManagedConnectionState('offline'));
        expect(setDaemonServerWorkOnline).toHaveBeenLastCalledWith(false);
        expect(onMachineConnectionOnline).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(pauseExternalSessionPassiveFollow).toHaveBeenCalledTimes(1);
        });
        expect(resumeExternalSessionPassiveFollow).not.toHaveBeenCalled();

        applyConnectionState(createManagedConnectionState('online'));
        expect(setDaemonServerWorkOnline).toHaveBeenLastCalledWith(true);
        await vi.waitFor(() => {
            expect(usageLimitRecoveryMutationCustodyMocks.bindRecoveredJournals).toHaveBeenCalledTimes(1);
            expect(onMachineConnectionOnline).toHaveBeenCalledTimes(1);
        });
        expect(usageLimitRecoveryMutationCustodyMocks.bindRecoveredJournals).toHaveBeenLastCalledWith([]);

        applyConnectionState(createManagedConnectionState('online'));
        await vi.waitFor(() => {
            expect(usageLimitRecoveryMutationCustodyMocks.bindRecoveredJournals).toHaveBeenCalledTimes(2);
        });
        expect(onMachineConnectionOnline).toHaveBeenCalledTimes(2);
        expect(pauseExternalSessionPassiveFollow).toHaveBeenCalledTimes(1);
        expect(resumeExternalSessionPassiveFollow).toHaveBeenCalledTimes(1);

        quiescing = true;
        applyConnectionState(createManagedConnectionState('offline'));
        applyConnectionState(createManagedConnectionState('online'));
        await Promise.resolve();

        expect(setDaemonServerWorkOnline).toHaveBeenCalledTimes(3);
        expect(usageLimitRecoveryMutationCustodyMocks.bindRecoveredJournals).toHaveBeenCalledTimes(2);
        expect(onMachineConnectionOnline).toHaveBeenCalledTimes(2);
        expect(pauseExternalSessionPassiveFollow).toHaveBeenCalledTimes(1);
        expect(resumeExternalSessionPassiveFollow).toHaveBeenCalledTimes(1);
    });

    it('starts the peer mediation machine RPC loopback route and publishes its endpoint on connect', async () => {
        const loopbackApp = fastify();
        const stopPeerMediationLoopbackServer = vi.fn(async () => {});
        const endpoint: PeerLoopbackEndpointCandidateV1 = {
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46011/peer-mediation/v1/probe',
            endpointFingerprint: 'endpoint_rpc_1',
            expiresAt: 602_000,
        };
        const startPeerMediationLoopbackServer = vi.fn(async () => ({
            app: loopbackApp,
            url: 'http://127.0.0.1:46011/peer-mediation/v1/probe',
            endpoint,
            stop: stopPeerMediationLoopbackServer,
        }));
        const streamCaptureAdapter = {
            start: vi.fn(async () => ({ ok: false as const, reasonCode: 'capture_unavailable' })),
        };
        const connectOptionsRef: { current: { onConnect?: () => Promise<void> | void } | null } = { current: null };
        const existingTransferState: DaemonState['transfer'] = {
            supported: { import: true, export: true },
            listenerClasses: {
                loopback_http: { enabled: true, configured: true, active: true },
                tailscale_serve_https: { enabled: false, configured: false, active: false },
            },
            lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
        };
        let daemonState: DaemonState | null = {
            status: 'running',
            transfer: existingTransferState,
        };
        let quiescing = false;
        const updateDaemonState = vi.fn(async (handler: (state: DaemonState | null) => DaemonState) => {
            if (updateDaemonState.mock.calls.length === 1) {
                quiescing = true;
                return 'suppressed' as const;
            }
            daemonState = handler(daemonState);
            return 'published' as const;
        });
        const refreshAssignments = vi.fn(async () => {});
        const firstMetadataPublication = createDeferred<'suppressed'>();
        const updateMachineMetadata = vi.fn(async () => {
            if (updateMachineMetadata.mock.calls.length === 1) {
                return await firstMetadataPublication.promise;
            }
            return 'published' as const;
        });
        const fakeConnectedApiMachine = {
            setRPCHandlers: vi.fn(),
            registerLiveStreamRelayRoutes: vi.fn(),
            onUpdate: vi.fn(() => () => {}),
            onConnectionStateChange: vi.fn(() => () => {}),
            onAccountSettingsVersionHint: vi.fn(() => () => {}),
            connect: vi.fn((options: { onConnect?: () => Promise<void> | void }) => {
                connectOptionsRef.current = options;
            }),
            updateDaemonState,
            updateMachineMetadata,
            emitExternalSessionTranscriptUpdate: vi.fn(),
            onMachineTransferEnvelope: vi.fn(() => () => {}),
            sendMachineTransferEnvelope: vi.fn(),
            onTransferRelayV2Envelope: vi.fn(() => () => {}),
            sendTransferRelayV2Envelope: vi.fn(),
            onMachineLiveStreamRelayEnvelope: vi.fn(() => () => {}),
            sendMachineLiveStreamRelayEnvelope: vi.fn(),
            getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
                invokeLocal: async () => ({ ok: true }),
            })),
        };
        // Test harness boundary: bootstrap accepts the concrete ApiMachineClient class, so this fixture supplies only methods the bootstrap path calls.
        const connectedApiMachine = fakeConnectedApiMachine as unknown as ConnectedApiMachineForBootstrap;
        const createConnectedApiMachine = vi.fn(() => connectedApiMachine);
        const attachTransferRuntimeStatePublisher = vi.fn(async () => {});
        const startVoiceInferenceWorkerForMachine = vi.fn(async (): Promise<VoiceInferenceWorkerHandle | null> => null);
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState,
            daemonStateVersion: 1,
        };

        const params = Object.assign({
            cliVersion: '0.0.0-test',
            machineId: 'machine-1',
            machine,
            preferredHost: 'host.local',
            happyHomeDir: '/tmp/happy-home',
            happyLibDir: '/tmp/happy-lib',
            filesystemAccessPolicy: { kind: 'osUser' as const },
            takeoverRequested: false,
            isShuttingDown: () => quiescing,
            createConnectedApiMachine,
            attachTransferRuntimeStatePublisher,
            startAutomationWorkerForMachine: vi.fn((): AutomationWorkerHandle => ({
                stop: vi.fn(),
                refreshAssignments,
                pause: vi.fn(),
                resume: vi.fn(),
                handleServerUpdate: vi.fn(),
            })),
            startMemoryWorkerForMachine: vi.fn(async (): Promise<MemoryWorkerHandle | null> => null),
            spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess-1' })),
            stopSession: vi.fn(async () => true),
            isSessionAlreadyRunning: vi.fn(async () => false),
            loadLocalSessionMetadataForHandoff: vi.fn(async () => null),
            savePreparedTargetLocalMetadata: vi.fn(async () => {}),
            beforeShutdown: vi.fn(async () => {}),
            requestShutdown: vi.fn(),
            directPeerServerLifecycle: null,
            directTransferPromptAssetAdapterRegistry: createPromptAssetAdapterRegistry(),
            directTransferPromptRegistryRegistry: createPromptRegistryAdapterRegistry(),
            connectedServiceRefreshLoopHandle: null,
            connectedServiceQuotasLoopHandle: null,
            daemonServerWorkScheduler: {} as never,
            startVoiceInferenceWorkerForMachine,
        }, {
            peerMediationMachineRpc: {
                accountId: 'account_1',
                serverFeatures: createPeerMediationServerFeatures({
                    rpcDirectPeerEnabled: true,
                    liveStreamDirectPeerEnabled: true,
                }),
                nowMs: () => 2_000,
                endpointFingerprint: () => 'endpoint_rpc_1',
                stream: { captureAdapter: streamCaptureAdapter },
                startPeerMediationLoopbackServer,
            },
        });

        const result: BootstrapMachineSyncRuntimeResult = await bootstrapMachineSyncRuntime(params);
        expect(startVoiceInferenceWorkerForMachine).toHaveBeenCalledWith('machine-1', 'account_1');
        const connectOptions = connectOptionsRef.current;
        if (!connectOptions?.onConnect) throw new Error('expected machine connect options');
        await connectOptions.onConnect();

        expect(startPeerMediationLoopbackServer).toHaveBeenCalledWith(expect.objectContaining({
            expected: expect.objectContaining({
                accountId: 'account_1',
                machineId: 'machine-1',
                flowKind: 'machine_rpc',
                routeKind: 'loopback_direct',
                endpointFingerprint: 'endpoint_rpc_1',
            }),
            rpc: expect.objectContaining({
                rpcHandlerManager: expect.objectContaining({
                    invokeLocal: expect.any(Function),
                }),
            }),
            stream: { captureAdapter: streamCaptureAdapter },
            expectedByFlow: expect.objectContaining({
                live_stream: expect.objectContaining({
                    flowKind: 'live_stream',
                    routeKind: 'loopback_direct',
                    endpointFingerprint: 'endpoint_rpc_1',
                }),
            }),
        }));
        expect(updateDaemonState).toHaveBeenCalled();
        expect(refreshAssignments).not.toHaveBeenCalled();
        expect(updateMachineMetadata).not.toHaveBeenCalled();
        expect(daemonState).not.toHaveProperty('peerMediation');
        expect(updateDaemonState).toHaveBeenCalledTimes(1);

        quiescing = false;
        const firstConnectionPublicationsResume = result.resumeMachineConnectionPublications();
        await vi.waitFor(() => expect(updateMachineMetadata).toHaveBeenCalledTimes(1));
        const joiningConnectionPublicationsResume = result.resumeMachineConnectionPublications();
        firstMetadataPublication.resolve('suppressed');
        await Promise.all([firstConnectionPublicationsResume, joiningConnectionPublicationsResume]);
        expect(updateDaemonState).toHaveBeenCalledTimes(3);
        expect(updateMachineMetadata).toHaveBeenCalledTimes(2);
        expect(daemonState).toMatchObject({
            status: 'running',
            transfer: existingTransferState,
            peerMediation: {
                loopback: {
                    endpoint: {
                        routeKind: 'loopback_direct',
                        endpointFingerprint: 'endpoint_rpc_1',
                    },
                    flows: {
                        machine_rpc: { active: true },
                        live_stream: { active: true },
                    },
                },
            },
        });

        await result.stopPeerMediationLoopbackServer();
        expect(stopPeerMediationLoopbackServer).toHaveBeenCalledOnce();
    });

    it('passes usage-limit recovery callbacks to machine RPC handlers and resumes inactive sessions through spawnSession', async () => {
        let providerServerFeaturesSnapshot: CliServerFeaturesSnapshot | undefined = {
            status: 'error',
            reason: 'timeout',
        };
        const storedRecoveryIntents = new Map<string, unknown>([
            ['sess-hydrated', {
                v: 1,
                issueFingerprint: 'persisted-limit',
                status: 'waiting',
                resumePromptMode: 'standard',
                armedAtMs: 1_000,
                resetAtMs: 2_000,
                nextCheckAtMs: 2_000,
                attemptCount: 0,
                maxAttempts: 3,
                lastProbeError: null,
                selectedAuth: { kind: 'native' },
            }],
        ]);
        const inactiveUsageLimitRecoveryStore = {
            read: (sessionId: string) => storedRecoveryIntents.get(sessionId) ?? null,
            readAll: vi.fn(() => Array.from(storedRecoveryIntents.entries())),
            write: vi.fn((sessionId: string, intent: unknown) => {
                storedRecoveryIntents.set(sessionId, intent);
            }),
        };
        let machineConnectionStateListener: ((state: ManagedConnectionState) => void) | null = null;
        const fakeConnectedApiMachine = {
            setRPCHandlers: vi.fn(),
            registerLiveStreamRelayRoutes: vi.fn(),
            onUpdate: vi.fn(() => () => {}),
            onConnectionStateChange: vi.fn((listener: (state: ManagedConnectionState) => void) => {
                machineConnectionStateListener = listener;
                return () => {
                    machineConnectionStateListener = null;
                };
            }),
            onAccountSettingsVersionHint: vi.fn(() => () => {}),
            onPendingSessionActivationHint: vi.fn(() => () => {}),
            connect: vi.fn(),
            updateDaemonState: vi.fn(async () => {}),
            updateMachineMetadata: vi.fn(async () => {}),
            emitExternalSessionTranscriptUpdate: vi.fn(),
            onMachineTransferEnvelope: vi.fn(() => () => {}),
            sendMachineTransferEnvelope: vi.fn(),
            onTransferRelayV2Envelope: vi.fn(() => () => {}),
            sendTransferRelayV2Envelope: vi.fn(),
            getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
                invokeLocal: async () => ({ ok: true }),
            })),
        };
        const connectedApiMachine = fakeConnectedApiMachine as unknown as ConnectedApiMachineForBootstrap;
        const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess-ready' }));
        const triggerLegacyProfileMigration = vi.fn(async () => ({ status: 'complete' as const, version: 1, outcomes: [] }));
        const cancelConnectedServiceRuntimeAuthRecovery = vi.fn(async () => ({ ok: true }));
        const awaitAgentSessionOpen = vi.fn();
        const onMachineConnectionOnline = vi.fn(async () => {
            providerServerFeaturesSnapshot = {
                status: 'ready',
                features: createProviderServerFeatures(true),
            };
            throw new Error('browser route refresh failed after feature recovery');
        });
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 1,
        };

        await bootstrapMachineSyncRuntime({
            cliVersion: '0.0.0-test',
            machineId: 'machine-1',
            machine,
            credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } },
            triggerLegacyProfileMigration,
            preferredHost: 'host.local',
            happyHomeDir: '/tmp/happy-home',
            happyLibDir: '/tmp/happy-lib',
            filesystemAccessPolicy: { kind: 'osUser' },
            takeoverRequested: false,
            isShuttingDown: () => false,
            createConnectedApiMachine: vi.fn(() => connectedApiMachine),
            attachTransferRuntimeStatePublisher: vi.fn(async () => {}),
            startAutomationWorkerForMachine: vi.fn((): AutomationWorkerHandle => ({
                stop: vi.fn(),
                refreshAssignments: vi.fn(async () => {}),
                pause: vi.fn(),
                resume: vi.fn(),
                handleServerUpdate: vi.fn(),
            })),
            startMemoryWorkerForMachine: vi.fn(async (): Promise<MemoryWorkerHandle | null> => null),
            spawnSession,
            stopSession: vi.fn(async () => true),
            awaitAgentSessionOpen,
            isSessionAlreadyRunning: vi.fn(async () => false),
            loadLocalSessionMetadataForHandoff: vi.fn(async () => null),
            savePreparedTargetLocalMetadata: vi.fn(async () => {}),
            beforeShutdown: vi.fn(async () => {}),
            requestShutdown: vi.fn(),
            directPeerServerLifecycle: null,
            directTransferPromptAssetAdapterRegistry: createPromptAssetAdapterRegistry(),
            directTransferPromptRegistryRegistry: createPromptRegistryAdapterRegistry(),
            connectedServiceRefreshLoopHandle: null,
            connectedServiceQuotasLoopHandle: null,
            daemonServerWorkScheduler: {} as never,
            startVoiceInferenceWorkerForMachine: vi.fn(async (): Promise<VoiceInferenceWorkerHandle | null> => null),
            inactiveUsageLimitRecoveryStore,
            cancelConnectedServiceRuntimeAuthRecovery,
            getServerFeaturesSnapshot: () => providerServerFeaturesSnapshot,
            peerMediationMachineRpc: { serverFeatures: null },
            onMachineConnectionOnline,
        });

        const rpcDeps = fakeConnectedApiMachine.setRPCHandlers.mock.calls[0]?.[1] as {
            resumeInactiveSessionWhenUsageLimitReady?: (input: {
                sessionId: string;
                rawSession: Record<string, unknown>;
                metadata: Record<string, unknown>;
            }) => Promise<boolean>;
            scheduleInactiveSessionUsageLimitRecoveryCheck?: (input: {
                sessionId: string;
                recovery: Record<string, unknown>;
                runCheckNow: () => Promise<unknown>;
            }) => Promise<void> | void;
            cancelInactiveSessionUsageLimitRecoveryCheck?: unknown;
            cancelConnectedServiceRuntimeAuthRecovery?: unknown;
            awaitAgentSessionOpen?: unknown;
            providerRpc?: Readonly<{
                machineId: string;
                services: Readonly<{
                    probe: unknown;
                    models: unknown;
                    loadModel: unknown;
                    cancelModelLoad: unknown;
                    previewProfileMigration: unknown;
                    confirmProfileMigration: unknown;
                    confirmProfileMigrationConflict: unknown;
                }>;
                featureGate: Readonly<{
                    isEnabled: (featureId: 'providers') => boolean;
                }>;
            }>;
        };
        expect(rpcDeps.awaitAgentSessionOpen).toBe(awaitAgentSessionOpen);

        expect(inactiveUsageLimitRecoveryStore.readAll).toHaveBeenCalledOnce();
        expect(rpcDeps.scheduleInactiveSessionUsageLimitRecoveryCheck).toEqual(expect.any(Function));
        expect(rpcDeps.cancelInactiveSessionUsageLimitRecoveryCheck).toEqual(expect.any(Function));
        expect(rpcDeps.cancelConnectedServiceRuntimeAuthRecovery).toBe(cancelConnectedServiceRuntimeAuthRecovery);
        expect(rpcDeps.providerRpc).toMatchObject({
            machineId: 'machine-1',
            services: {
                probe: expect.any(Function),
                models: expect.any(Function),
                loadModel: expect.any(Function),
                cancelModelLoad: expect.any(Function),
                previewProfileMigration: expect.any(Function),
                confirmProfileMigration: expect.any(Function),
                confirmProfileMigrationConflict: expect.any(Function),
            },
            featureGate: { isEnabled: expect.any(Function) },
        });
        expect(triggerLegacyProfileMigration).toHaveBeenCalledWith(expect.objectContaining({
            providersEnabled: false,
            machineId: 'machine-1',
        }));
        expect(rpcDeps.providerRpc?.featureGate.isEnabled('providers')).toBe(false);

        requireManagedConnectionStateListener(machineConnectionStateListener)(createManagedConnectionState('online'));
        await vi.waitFor(() => expect(triggerLegacyProfileMigration).toHaveBeenLastCalledWith(expect.objectContaining({
            providersEnabled: true,
            machineId: 'machine-1',
        })));
        expect(onMachineConnectionOnline).toHaveBeenCalledOnce();
        expect(rpcDeps.providerRpc?.featureGate.isEnabled('providers')).toBe(true);

        providerServerFeaturesSnapshot = {
            status: 'ready',
            features: createProviderServerFeatures(false),
        };
        expect(rpcDeps.providerRpc?.featureGate.isEnabled('providers')).toBe(false);

        providerServerFeaturesSnapshot = {
            status: 'ready',
            features: createPeerMediationServerFeatures(),
        };
        expect(rpcDeps.providerRpc?.featureGate.isEnabled('providers')).toBe(false);
        await rpcDeps.scheduleInactiveSessionUsageLimitRecoveryCheck?.({
            sessionId: 'sess-scheduled',
            recovery: {
                v: 1,
                issueFingerprint: 'scheduled-limit',
                status: 'waiting',
                resumePromptMode: 'standard',
                armedAtMs: 2_000,
                resetAtMs: 3_000,
                nextCheckAtMs: 3_000,
                attemptCount: 0,
                maxAttempts: 3,
                lastProbeError: null,
                selectedAuth: { kind: 'native' },
            },
            runCheckNow: vi.fn(async () => ({ status: 'waiting' })),
        });
        expect(storedRecoveryIntents.get('sess-scheduled')).toMatchObject({
            issueFingerprint: 'scheduled-limit',
        });
        await expect(rpcDeps.resumeInactiveSessionWhenUsageLimitReady?.({
            sessionId: 'sess-ready',
            rawSession: { id: 'sess-ready', path: '/repo/from-raw', machineId: 'machine-1' },
            metadata: {
                machineId: 'machine-1',
                path: '/repo/from-raw',
                flavor: 'claude',
                permissionMode: 'yolo',
                permissionModeUpdatedAt: 1000,
                sessionModeOverrideV1: { v: 1, modeId: 'plan', updatedAt: 1010 },
                modelOverrideV1: { v: 1, modelId: 'claude-opus-4-7', updatedAt: 1020 },
                connectedServices: {
                    v: 1,
                    bindingsByServiceId: {
                        anthropic: { source: 'connected', selection: 'profile', profileId: 'claude-work' },
                    },
                },
                connectedServicesUpdatedAt: 1030,
                connectedServiceMaterializationIdentityV1: {
                    v: 1,
                    id: 'csm_inactive_resume',
                    createdAt: 1040,
                },
            },
        })).resolves.toBe(true);
        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            existingSessionId: 'sess-ready',
            machineId: 'machine-1',
            directory: '/repo/from-raw',
            backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            connectedServices: {
                v: 1,
                bindingsByServiceId: {
                    anthropic: { source: 'connected', selection: 'profile', profileId: 'claude-work' },
                },
            },
            connectedServicesUpdatedAt: 1030,
            connectedServiceMaterializationIdentityV1: {
                v: 1,
                id: 'csm_inactive_resume',
                createdAt: 1040,
            },
            permissionMode: 'yolo',
            permissionModeUpdatedAt: 1000,
            agentModeId: 'plan',
            agentModeUpdatedAt: 1010,
            modelSelection: {
                v: 1,
                updatedAt: 1020,
                ref: {
                    agentTargetKey: 'backend:claude',
                    providerConnectionId: null,
                    modelId: 'claude-opus-4-7',
                },
            },
            approvedNewDirectoryCreation: true,
        }));
    });

    it('binds server-relayed live-stream starts to the daemon capture source', async () => {
        let liveStreamRelayListener: ((payload: MachineLiveStreamRelayEnvelopeV1) => void) | null = null;
        let liveStreamRelayRoutes: {
            start: (startRequest: unknown) => Promise<{ ok: true; streamId: string } | { ok: false; reasonCode: string }>;
        } | null = null;
        const sentLiveStreamEnvelopes: MachineLiveStreamRelayEnvelopeV1[] = [];
        const fakeConnectedApiMachine = {
            registerLiveStreamRelayRoutes: vi.fn((routes: NonNullable<typeof liveStreamRelayRoutes>) => {
                liveStreamRelayRoutes = routes;
            }),
            setRPCHandlers: vi.fn(),
            onUpdate: vi.fn(() => () => {}),
            onConnectionStateChange: vi.fn(() => () => {}),
            connect: vi.fn(),
            updateDaemonState: vi.fn(async () => {}),
            updateMachineMetadata: vi.fn(async () => {}),
            emitExternalSessionTranscriptUpdate: vi.fn(),
            onMachineTransferEnvelope: vi.fn(() => () => {}),
            sendMachineTransferEnvelope: vi.fn(),
            onTransferRelayV2Envelope: vi.fn(() => () => {}),
            sendTransferRelayV2Envelope: vi.fn(),
            onMachineLiveStreamRelayEnvelope: vi.fn((listener: (payload: MachineLiveStreamRelayEnvelopeV1) => void) => {
                liveStreamRelayListener = listener;
                return () => {
                    liveStreamRelayListener = null;
                };
            }),
            sendMachineLiveStreamRelayEnvelope: vi.fn((payload: MachineLiveStreamRelayEnvelopeV1) => {
                sentLiveStreamEnvelopes.push(payload);
            }),
            getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
                invokeLocal: async () => ({ ok: true }),
            })),
        };
        const connectedApiMachine = fakeConnectedApiMachine as unknown as ConnectedApiMachineForBootstrap;
        const appliedSidebandControls: unknown[] = [];
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 1,
        };
        const caps = {
            maxBitrateBps: 64_000,
            maxFramesPerSecond: 12,
            maxFrameBytes: 8_192,
            maxDurationMs: 60_000,
            maxTotalBytes: 128_000,
        };

        await bootstrapMachineSyncRuntime({
            cliVersion: '0.0.0-test',
            machineId: 'machine-1',
            machine,
            preferredHost: 'host.local',
            happyHomeDir: '/tmp/happy-home',
            happyLibDir: '/tmp/happy-lib',
            filesystemAccessPolicy: { kind: 'osUser' },
            takeoverRequested: false,
            isShuttingDown: () => false,
            createConnectedApiMachine: vi.fn(() => connectedApiMachine),
            attachTransferRuntimeStatePublisher: vi.fn(async () => {}),
            startAutomationWorkerForMachine: vi.fn((): AutomationWorkerHandle => ({
                stop: vi.fn(),
                refreshAssignments: vi.fn(async () => {}),
                pause: vi.fn(),
                resume: vi.fn(),
                handleServerUpdate: vi.fn(),
            })),
            startMemoryWorkerForMachine: vi.fn(async (): Promise<MemoryWorkerHandle | null> => null),
            spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess-1' })),
            stopSession: vi.fn(async () => true),
            isSessionAlreadyRunning: vi.fn(async () => false),
            loadLocalSessionMetadataForHandoff: vi.fn(async () => null),
            savePreparedTargetLocalMetadata: vi.fn(async () => {}),
            beforeShutdown: vi.fn(async () => {}),
            requestShutdown: vi.fn(),
            directPeerServerLifecycle: null,
            directTransferPromptAssetAdapterRegistry: createPromptAssetAdapterRegistry(),
            directTransferPromptRegistryRegistry: createPromptRegistryAdapterRegistry(),
            connectedServiceRefreshLoopHandle: null,
            connectedServiceQuotasLoopHandle: null,
            daemonServerWorkScheduler: {} as never,
            startVoiceInferenceWorkerForMachine: vi.fn(async (): Promise<VoiceInferenceWorkerHandle | null> => null),
            peerMediationMachineRpc: {
                nowMs: () => 2_000,
                stream: {
                    readActiveControlLease: ({ streamId, sourceId }) => ({
                        v: 1,
                        leaseId: 'lease_1',
                        streamId,
                        sourceId,
                        holderId: 'viewer_1',
                        mode: 'exclusive',
                        acquiredAtMs: 1_000,
                        expiresAtMs: 3_000,
                    }),
                    captureAdapter: {
                        start: async (input) => {
                            input.offerFrame({
                                v: 1,
                                streamId: input.streamId,
                                sequence: 1,
                                timestampMs: 2_000,
                                payloadKind: 'image_keyframe',
                                payloadEncoding: 'binary_base64',
	                                payloadBase64: 'AQID',
	                                payloadSizeBytes: 3,
	                            });
	                            return {
	                                ok: true,
	                                session: {
	                                    stop: () => undefined,
	                                    applySidebandControl: (control) => {
	                                        appliedSidebandControls.push(control);
	                                        return { ok: true };
	                                    },
	                                },
	                            };
	                        },
	                    },
	                },
            },
        });

        expect(fakeConnectedApiMachine.onMachineLiveStreamRelayEnvelope).toHaveBeenCalledOnce();
        // SIM-P0-1: the start now arrives over machine RPC (the server never forwards `start`
        // envelopes into machine rooms), so the bootstrap must expose the relay start route.
        expect(fakeConnectedApiMachine.registerLiveStreamRelayRoutes).toHaveBeenCalledOnce();
        const relayRoutes = liveStreamRelayRoutes as {
            start: (startRequest: unknown) => Promise<{ ok: true; streamId: string } | { ok: false; reasonCode: string }>;
        } | null;
        if (!relayRoutes) throw new Error('expected live-stream relay start route');
        const relayListener = liveStreamRelayListener as ((payload: MachineLiveStreamRelayEnvelopeV1) => void) | null;
        if (!relayListener) throw new Error('expected live-stream relay listener');
        const startResult = await relayRoutes.start({
            v: 1,
            streamId: 'stream_1',
            streamFamily: 'screen',
            routeKind: 'server_relay',
            sourceMachineId: 'machine-1',
            targetMachineId: 'viewer-machine',
            ...caps,
            authorization: {
                payload: {
                    v: 1,
                    grantId: 'grant_1',
                    accountId: 'account_1',
                    sourceMachineId: 'machine-1',
                    targetMachineId: 'viewer-machine',
                    flowKind: 'live_stream',
                    routeKind: 'server_relay',
                    streamId: 'stream_1',
                    streamFamily: 'screen',
                    ...caps,
                    iat: 1_000,
                    exp: 62_000,
                    aud: 'happier-live-stream-relay-authorization',
                },
                signature: {
                    keyId: 'relay-key-1',
                    alg: 'Ed25519',
                    valueBase64Url: 'signature',
                },
            },
        });
        expect(startResult).toEqual({ ok: true, streamId: 'stream_1' });

	        expect(sentLiveStreamEnvelopes.map((envelope) => envelope.message.kind)).toEqual(['start', 'frame']);
	        relayListener({
	            v: 1,
	            sourceMachineId: 'machine-1',
	            targetMachineId: 'viewer-machine',
	            message: {
	                kind: 'sideband_control',
	                control: {
	                    v: 1,
	                    streamId: 'stream_1',
	                    sourceId: 'source_1',
	                    eventId: 'tap_1',
	                    leaseId: 'lease_1',
	                    kind: 'tap',
	                    x: 0.25,
	                    y: 0.75,
	                },
	            },
	        });

	        expect(appliedSidebandControls).toEqual([
	            expect.objectContaining({ kind: 'tap', eventId: 'tap_1' }),
        ]);
    });

    it('binds server-relayed TCP tunnel envelopes to the daemon relay terminator', async () => {
        const tcpTunnelRelayListener: {
            current: ((payload: PeerTcpTunnelRelayEnvelope) => void | Promise<void>) | null;
        } = { current: null };
        const sentTcpTunnelEnvelopes: PeerTcpTunnelRelayEnvelope[] = [];
        const fakeConnectedApiMachine = {
            setRPCHandlers: vi.fn(),
            registerLiveStreamRelayRoutes: vi.fn(),
            onUpdate: vi.fn(() => () => {}),
            onConnectionStateChange: vi.fn(() => () => {}),
            connect: vi.fn(),
            updateDaemonState: vi.fn(async () => {}),
            updateMachineMetadata: vi.fn(async () => {}),
            emitExternalSessionTranscriptUpdate: vi.fn(),
            onMachineTransferEnvelope: vi.fn(() => () => {}),
            sendMachineTransferEnvelope: vi.fn(),
            onTransferRelayV2Envelope: vi.fn(() => () => {}),
            sendTransferRelayV2Envelope: vi.fn(),
            onMachineLiveStreamRelayEnvelope: vi.fn(() => () => {}),
            sendMachineLiveStreamRelayEnvelope: vi.fn(),
            onPeerTcpTunnelRelayEnvelope: vi.fn((listener: (payload: PeerTcpTunnelRelayEnvelope) => void | Promise<void>) => {
                tcpTunnelRelayListener.current = listener;
                return () => {
                    tcpTunnelRelayListener.current = null;
                };
            }),
            sendPeerTcpTunnelRelayEnvelope: vi.fn((payload: PeerTcpTunnelRelayEnvelope) => {
                sentTcpTunnelEnvelopes.push(payload);
            }),
            getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
                invokeLocal: async () => ({ ok: true }),
            })),
        };
        const connectedApiMachine = fakeConnectedApiMachine as unknown as ConnectedApiMachineForBootstrap;
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState: null,
            daemonStateVersion: 1,
        };

        const result = await bootstrapMachineSyncRuntime({
            cliVersion: '0.0.0-test',
            machineId: 'machine-1',
            machine,
            preferredHost: 'host.local',
            happyHomeDir: '/tmp/happy-home',
            happyLibDir: '/tmp/happy-lib',
            filesystemAccessPolicy: { kind: 'osUser' },
            takeoverRequested: false,
            isShuttingDown: () => false,
            createConnectedApiMachine: vi.fn(() => connectedApiMachine),
            attachTransferRuntimeStatePublisher: vi.fn(async () => {}),
            startAutomationWorkerForMachine: vi.fn((): AutomationWorkerHandle => ({
                stop: vi.fn(),
                refreshAssignments: vi.fn(async () => {}),
                pause: vi.fn(),
                resume: vi.fn(),
                handleServerUpdate: vi.fn(),
            })),
            startMemoryWorkerForMachine: vi.fn(async (): Promise<MemoryWorkerHandle | null> => null),
            spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess-1' })),
            stopSession: vi.fn(async () => true),
            isSessionAlreadyRunning: vi.fn(async () => false),
            loadLocalSessionMetadataForHandoff: vi.fn(async () => null),
            savePreparedTargetLocalMetadata: vi.fn(async () => {}),
            beforeShutdown: vi.fn(async () => {}),
            requestShutdown: vi.fn(),
            directPeerServerLifecycle: null,
            directTransferPromptAssetAdapterRegistry: createPromptAssetAdapterRegistry(),
            directTransferPromptRegistryRegistry: createPromptRegistryAdapterRegistry(),
            connectedServiceRefreshLoopHandle: null,
            connectedServiceQuotasLoopHandle: null,
            daemonServerWorkScheduler: {} as never,
            startVoiceInferenceWorkerForMachine: vi.fn(async (): Promise<VoiceInferenceWorkerHandle | null> => null),
            peerMediationMachineRpc: {
                accountId: 'account_1',
                serverFeatures: createPeerMediationServerFeatures({
                    rpcDirectPeerEnabled: false,
                    tunnelServerRoutedEnabled: true,
                }),
                nowMs: () => 2_000,
            },
        });

        expect(fakeConnectedApiMachine.onPeerTcpTunnelRelayEnvelope).toHaveBeenCalledOnce();
        const relayListener = tcpTunnelRelayListener.current;
        if (!relayListener) throw new Error('expected TCP tunnel relay listener');

        const invalidOpenEnvelope: PeerTcpTunnelRelayEnvelope = {
            v: 1,
            scopeUserId: 'account_1',
            sender: { kind: 'user' },
            recipient: { kind: 'machine', machineId: 'machine-1' },
            frame: {
                v: 1,
                kind: 'open',
                open: {
                    v: 1,
                    kind: 'open',
                    tunnelId: 'tun_invalid_auth',
                    targetMachineId: 'machine-1',
                    routeKind: 'server_relay',
                    destination: { host: '127.0.0.1', port: 3000 },
                    selectedEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
                    relayAuthorization: {
                        payload: {
                            v: 1,
                            grantId: 'relay_grant_1',
                            accountId: 'account_1',
                            targetMachineId: 'machine-1',
                            flowKind: 'tcp_tunnel',
                            routeKind: 'server_relay',
                            tunnelId: 'tun_invalid_auth',
                            destination: { host: '127.0.0.1', port: 3000 },
                            capProfileId: 'interactive',
                            maxFrameBytes: 64 * 1024,
                            maxIdleMs: 30_000,
                            maxDurationMs: 300_000,
                            maxTotalBytes: 64 * 1024 * 1024,
                            iat: 1_000,
                            exp: 301_000,
                            aud: 'happier-tcp-tunnel-relay-authorization',
                        },
                        signature: {
                            keyId: 'grant-key-1',
                            alg: 'Ed25519',
                            valueBase64Url: Buffer.from(new Uint8Array(64).fill(1)).toString('base64url'),
                        },
                    },
                },
            },
        };
        await Promise.resolve(relayListener(invalidOpenEnvelope));

        expect(sentTcpTunnelEnvelopes).toEqual([
            expect.objectContaining({
                frame: expect.objectContaining({
                    kind: 'abort',
                    tunnelId: 'tun_invalid_auth',
                    reasonCode: 'relay_authorization_invalid',
                }),
            }),
        ]);

        result.machineConnectionStateCleanup?.();
        expect(tcpTunnelRelayListener.current).toBeNull();
    });

    it('starts the peer mediation TCP tunnel loopback route through the daemon lifecycle when RPC is disabled', async () => {
        const loopbackApp = fastify();
        const stopPeerMediationLoopbackServer = vi.fn(async () => {});
        const appendSttStreamBinaryFrame = vi.fn(async () => ({
            ok: true,
            streamId: 'stream-1',
            generation: 0,
            ackSeq: 0,
            events: [],
        }));
        const cancelSttStreamForTransportLoss = vi.fn(async () => ({
            ok: true,
            streamId: 'stream-1',
            generation: 0,
        }));
        const machineRpcLifecycleRegistration = {
            voiceInference: {
                voiceInferenceStreaming: {
                    appendSttStreamBinaryFrame,
                    cancelSttStreamForTransportLoss,
                },
            },
        } as unknown as ReturnType<ConnectedApiMachineForBootstrap['setRPCHandlers']>;
        const endpoint: PeerLoopbackEndpointCandidateV1 = {
            v: 1,
            routeKind: 'loopback_direct',
            url: 'http://127.0.0.1:46012/peer-mediation/v1/probe',
            endpointFingerprint: 'endpoint_tunnel_1',
            expiresAt: 602_000,
        };
        const startPeerMediationLoopbackServer = vi.fn(async () => ({
            app: loopbackApp,
            url: 'http://127.0.0.1:46012/peer-mediation/v1/probe',
            endpoint,
            stop: stopPeerMediationLoopbackServer,
        }));
        const connectOptionsRef: { current: { onConnect?: () => Promise<void> | void } | null } = { current: null };
        let daemonState: DaemonState | null = { status: 'running' };
        const updateDaemonState = vi.fn(async (handler: (state: DaemonState | null) => DaemonState) => {
            daemonState = handler(daemonState);
        });
        const fakeConnectedApiMachine = {
            setRPCHandlers: vi.fn(() => machineRpcLifecycleRegistration),
            onUpdate: vi.fn(() => () => {}),
            onConnectionStateChange: vi.fn(() => () => {}),
            connect: vi.fn((options: { onConnect?: () => Promise<void> | void }) => {
                connectOptionsRef.current = options;
            }),
            updateDaemonState,
            updateMachineMetadata: vi.fn(async () => {}),
            emitExternalSessionTranscriptUpdate: vi.fn(),
            onMachineTransferEnvelope: vi.fn(() => () => {}),
            sendMachineTransferEnvelope: vi.fn(),
            onTransferRelayV2Envelope: vi.fn(() => () => {}),
            sendTransferRelayV2Envelope: vi.fn(),
            getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
                invokeLocal: async () => ({ ok: true }),
            })),
        };
        // Test harness boundary: bootstrap accepts the concrete ApiMachineClient class, so this fixture supplies only methods the bootstrap path calls.
        const connectedApiMachine = fakeConnectedApiMachine as unknown as ConnectedApiMachineForBootstrap;
        const machine: Machine = {
            id: 'machine-1',
            encryptionKey: new Uint8Array(32).fill(7),
            encryptionVariant: 'legacy',
            metadata: null,
            metadataVersion: 0,
            daemonState,
            daemonStateVersion: 1,
        };

        const result = await bootstrapMachineSyncRuntime({
            cliVersion: '0.0.0-test',
            machineId: 'machine-1',
            machine,
            preferredHost: 'host.local',
            happyHomeDir: '/tmp/happy-home',
            happyLibDir: '/tmp/happy-lib',
            filesystemAccessPolicy: { kind: 'osUser' },
            takeoverRequested: false,
            isShuttingDown: () => false,
            createConnectedApiMachine: vi.fn(() => connectedApiMachine),
            attachTransferRuntimeStatePublisher: vi.fn(async () => {}),
            startAutomationWorkerForMachine: vi.fn((): AutomationWorkerHandle => ({
                stop: vi.fn(),
                refreshAssignments: vi.fn(async () => {}),
                pause: vi.fn(),
                resume: vi.fn(),
                handleServerUpdate: vi.fn(),
            })),
            startMemoryWorkerForMachine: vi.fn(async (): Promise<MemoryWorkerHandle | null> => null),
            spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess-1' })),
            stopSession: vi.fn(async () => true),
            isSessionAlreadyRunning: vi.fn(async () => false),
            loadLocalSessionMetadataForHandoff: vi.fn(async () => null),
            savePreparedTargetLocalMetadata: vi.fn(async () => {}),
            beforeShutdown: vi.fn(async () => {}),
            requestShutdown: vi.fn(),
            directPeerServerLifecycle: null,
            directTransferPromptAssetAdapterRegistry: createPromptAssetAdapterRegistry(),
            directTransferPromptRegistryRegistry: createPromptRegistryAdapterRegistry(),
            connectedServiceRefreshLoopHandle: null,
            connectedServiceQuotasLoopHandle: null,
            daemonServerWorkScheduler: {} as never,
            startVoiceInferenceWorkerForMachine: vi.fn(async (): Promise<VoiceInferenceWorkerHandle | null> =>
                createVoiceInferenceWorkerHandle()),
            peerMediationMachineRpc: {
                accountId: 'account_1',
                serverFeatures: createPeerMediationServerFeatures({
                    rpcDirectPeerEnabled: false,
                    tunnelDirectPeerEnabled: true,
                }),
                nowMs: () => 2_000,
                endpointFingerprint: () => 'endpoint_tunnel_1',
                startPeerMediationLoopbackServer,
            },
        });
        const connectOptions = connectOptionsRef.current;
        if (!connectOptions?.onConnect) throw new Error('expected machine connect options');
        await connectOptions.onConnect();

        expect(startPeerMediationLoopbackServer).toHaveBeenCalledWith(expect.objectContaining({
            expected: expect.objectContaining({
                accountId: 'account_1',
                machineId: 'machine-1',
                flowKind: 'tcp_tunnel',
                routeKind: 'loopback_direct',
                endpointFingerprint: 'endpoint_tunnel_1',
            }),
            tunnel: expect.objectContaining({
                voiceBinaryAppendConsumer: appendSttStreamBinaryFrame,
                voiceBinaryTerminalConsumer: cancelSttStreamForTransportLoss,
            }),
        }));
        expect(startPeerMediationLoopbackServer).toHaveBeenCalledWith(expect.not.objectContaining({
            rpc: expect.any(Object),
        }));
        expect(daemonState).toMatchObject({
            status: 'running',
            peerMediation: {
                loopback: {
                    endpoint: {
                        routeKind: 'loopback_direct',
                        endpointFingerprint: 'endpoint_tunnel_1',
                    },
                    flows: {
                        tcp_tunnel: { active: true },
                    },
                },
            },
        });

        await result.stopPeerMediationLoopbackServer();
        expect(stopPeerMediationLoopbackServer).toHaveBeenCalledOnce();
    });
});
