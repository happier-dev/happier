import { describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import {
    FeaturesResponseSchema,
    type FeaturesResponse,
    type PeerLoopbackEndpointCandidateV1,
} from '@happier-dev/protocol';

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

function createPeerMediationServerFeatures(options: Readonly<{
    rpcDirectPeerEnabled?: boolean;
    tunnelDirectPeerEnabled?: boolean;
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
            emitDirectSessionTranscriptUpdate: vi.fn(),
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
            emitDirectSessionTranscriptUpdate: vi.fn(),
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
