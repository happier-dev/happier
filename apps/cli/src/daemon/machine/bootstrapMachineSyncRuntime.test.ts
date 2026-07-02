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
            machineConnectionStateCleanup: null,
            stopPeerMediationLoopbackServer: expect.any(Function),
        });
    });

    it('updates server-work connectivity and wakes quota persistence on machine connection changes', async () => {
        let connectionStateListener: ((state: ManagedConnectionState) => void) | null = null;
        const fakeConnectedApiMachine = {
            setRPCHandlers: vi.fn(),
            onUpdate: vi.fn(() => () => {}),
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
            preferredHost: 'host.local',
            happyHomeDir: '/tmp/happy-home',
            happyLibDir: '/tmp/happy-lib',
            filesystemAccessPolicy: { kind: 'osUser' as const },
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

        applyConnectionState(createManagedConnectionState('online'));
        expect(setDaemonServerWorkOnline).toHaveBeenLastCalledWith(true);
        expect(onMachineConnectionOnline).toHaveBeenCalledTimes(1);
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
                lan_http: { enabled: false, configured: false, active: false },
                tailscale_serve_https: { enabled: false, configured: false, active: false },
            },
            lifecycle: { mode: 'lazy_idle_shutdown', version: 1 },
        };
        let daemonState: DaemonState | null = {
            status: 'running',
            transfer: existingTransferState,
        };
        const updateDaemonState = vi.fn(async (handler: (state: DaemonState | null) => DaemonState) => {
            daemonState = handler(daemonState);
        });
        const fakeConnectedApiMachine = {
            setRPCHandlers: vi.fn(),
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
            isShuttingDown: () => false,
            createConnectedApiMachine,
            attachTransferRuntimeStatePublisher,
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
        const fakeConnectedApiMachine = {
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
            getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
                invokeLocal: async () => ({ ok: true }),
            })),
        };
        const connectedApiMachine = fakeConnectedApiMachine as unknown as ConnectedApiMachineForBootstrap;
        const spawnSession = vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'sess-ready' }));
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
            }) => void;
            cancelInactiveSessionUsageLimitRecoveryCheck?: unknown;
        };

        expect(inactiveUsageLimitRecoveryStore.readAll).toHaveBeenCalledOnce();
        expect(rpcDeps.scheduleInactiveSessionUsageLimitRecoveryCheck).toEqual(expect.any(Function));
        expect(rpcDeps.cancelInactiveSessionUsageLimitRecoveryCheck).toEqual(expect.any(Function));
        rpcDeps.scheduleInactiveSessionUsageLimitRecoveryCheck?.({
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
            rawSession: { id: 'sess-ready', path: '/repo/from-raw', machineId: 'machine-from-raw' },
            metadata: {
                machineId: 'machine-1',
                path: '/repo',
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
            machineId: 'machine-from-raw',
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
            modelId: 'claude-opus-4-7',
            modelUpdatedAt: 1020,
            approvedNewDirectoryCreation: true,
        }));
    });

    it('binds server-relayed live-stream starts to the daemon capture source', async () => {
        let liveStreamRelayListener: ((payload: MachineLiveStreamRelayEnvelopeV1) => void) | null = null;
        const sentLiveStreamEnvelopes: MachineLiveStreamRelayEnvelopeV1[] = [];
        const fakeConnectedApiMachine = {
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
        const relayListener = liveStreamRelayListener as ((payload: MachineLiveStreamRelayEnvelopeV1) => void) | null;
        if (!relayListener) throw new Error('expected live-stream relay listener');
        relayListener({
            v: 1,
            sourceMachineId: 'machine-1',
            targetMachineId: 'viewer-machine',
            message: {
                kind: 'start',
                startRequest: {
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
                },
            },
        });
	        await Promise.resolve();

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
            setRPCHandlers: vi.fn(),
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
            startVoiceInferenceWorkerForMachine: vi.fn(async (): Promise<VoiceInferenceWorkerHandle | null> => null),
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
            tunnel: expect.any(Object),
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
