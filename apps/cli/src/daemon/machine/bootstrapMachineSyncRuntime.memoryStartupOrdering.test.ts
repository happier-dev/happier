import { describe, expect, it, vi } from 'vitest';

import type { Machine } from '@/api/types';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import { DEFAULT_MEMORY_SETTINGS } from '@/settings/memorySettings';
import { createDeferred } from '@/testkit/async/deferred';
import type { SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';

import type { AutomationWorkerHandle } from '../automation/automationWorker';
import type { MemoryWorkerHandle } from '../memory/memoryWorker';
import { buildUnavailableMemoryEmbeddingsDiagnostics } from '../memory/resolveOperationalMemoryEmbeddingsSettings';
import type { VoiceInferenceWorkerHandle } from '../voiceInference/voiceInferenceWorker';
import { bootstrapMachineSyncRuntime } from './bootstrapMachineSyncRuntime';
import type { BootstrapMachineSyncRuntimeParams } from './bootstrapMachineSyncRuntime';

type ConnectedApiMachine = NonNullable<
  Awaited<ReturnType<BootstrapMachineSyncRuntimeParams['createConnectedApiMachine']>>
>;

describe('bootstrapMachineSyncRuntime memory startup ordering', () => {
  it('does not connect the Account changes carrier until deletion and revocation purges are subscribed', async () => {
    const memoryStartup = createDeferred<MemoryWorkerHandle>();
    const removeSessions = vi.fn(async () => {});
    const memoryWorker: MemoryWorkerHandle = {
      stop: vi.fn(),
      reloadSettings: vi.fn(async () => {}),
      ensureUpToDate: vi.fn(async () => {}),
      removeSessions,
      reconcileRetainedSessionAccess: vi.fn(async () => {}),
      listIndexedSessionIds: vi.fn(() => []),
      applySessionArchivedState: vi.fn(async () => {}),
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
    let deletedListener: ((change: { sessionId: string }) => void | Promise<void>) | null = null;
    let revokedListener: ((change: { sessionId: string }) => void | Promise<void>) | null = null;
    let resetListener: ((change: { cursor: number }) => void | Promise<void>) | null = null;
    const connect = vi.fn(() => {
      if (!deletedListener || !revokedListener || !resetListener) {
        throw new Error('changes carrier connected before memory purge subscriptions');
      }
    });
    const apiMachine = {
      setRPCHandlers: vi.fn(() => ({}) as ReturnType<ConnectedApiMachine['setRPCHandlers']>),
      registerLiveStreamRelayRoutes: vi.fn(),
      onUpdate: vi.fn(() => () => {}),
      onAccountSettingsVersionHint: vi.fn(() => () => {}),
      onAccountProjectRowsChanged: vi.fn(() => () => {}),
      onPendingSessionActivationHint: vi.fn(() => () => {}),
      onSessionDeletedChange: vi.fn((listener: NonNullable<typeof deletedListener>) => {
        deletedListener = listener;
        return () => { deletedListener = null; };
      }),
      onSessionAccessRevoked: vi.fn((listener: NonNullable<typeof revokedListener>) => {
        revokedListener = listener;
        return () => { revokedListener = null; };
      }),
      onSessionAccessReset: vi.fn((listener: NonNullable<typeof resetListener>) => {
        resetListener = listener;
        return () => { resetListener = null; };
      }),
      onSessionArchivedStateChange: vi.fn(() => () => {}),
      onConnectionStateChange: vi.fn(() => () => {}),
      connect,
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
    } as unknown as ConnectedApiMachine;
    const automationWorker: AutomationWorkerHandle = {
      stop: vi.fn(),
      refreshAssignments: vi.fn(async () => {}),
      pause: vi.fn(),
      resume: vi.fn(),
      handleServerUpdate: vi.fn(),
    };
    const startMemoryWorkerForMachine = vi.fn(async () => await memoryStartup.promise);
    const machine: Machine = {
      id: 'machine-memory-startup-ordering',
      encryptionMode: 'plain',
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    const bootstrap = bootstrapMachineSyncRuntime({
      cliVersion: '0.0.0-test',
      machineId: machine.id,
      machine,
      credentials: { token: 'token', encryption: null },
      preferredHost: 'host.local',
      happyHomeDir: '/tmp/happy-home',
      happyLibDir: '/tmp/happy-lib',
      filesystemAccessPolicy: { kind: 'osUser' },
      takeoverRequested: false,
      isShuttingDown: () => false,
      createConnectedApiMachine: vi.fn(() => apiMachine),
      attachTransferRuntimeStatePublisher: vi.fn(async () => {}),
      startAutomationWorkerForMachine: vi.fn(() => automationWorker),
      startMemoryWorkerForMachine,
      startVoiceInferenceWorkerForMachine: vi.fn(async (): Promise<VoiceInferenceWorkerHandle | null> => null),
      spawnSession: vi.fn(async (): Promise<SpawnSessionResult> => ({ type: 'success', sessionId: 'session-1' })),
      stopSession: vi.fn(async () => ({ status: 'stopped' as const })),
      isSessionAlreadyRunning: vi.fn(async () => false),
      loadLocalSessionMetadataForHandoff: vi.fn(async () => null),
      beforeShutdown: vi.fn(async () => {}),
      requestShutdown: vi.fn(),
      directPeerServerLifecycle: null,
      directTransferPromptAssetAdapterRegistry: createPromptAssetAdapterRegistry(),
      directTransferPromptRegistryRegistry: createPromptRegistryAdapterRegistry(),
      connectedServiceRefreshLoopHandle: null,
      connectedServiceQuotasLoopHandle: null,
      daemonServerWorkScheduler: {} as never,
    });

    await vi.waitFor(() => expect(startMemoryWorkerForMachine).toHaveBeenCalledOnce());
    expect(connect).not.toHaveBeenCalled();
    // Directory cleanup is subscribed while memory startup is still pending;
    // the memory consumer itself remains unavailable until startup resolves.
    expect(deletedListener).not.toBeNull();
    expect(revokedListener).toBeNull();
    expect(resetListener).not.toBeNull();
    expect(removeSessions).not.toHaveBeenCalled();

    memoryStartup.resolve(memoryWorker);
    await bootstrap;

    expect(connect).toHaveBeenCalledOnce();
    expect(deletedListener).not.toBeNull();
    expect(revokedListener).not.toBeNull();
    expect(resetListener).not.toBeNull();
    const emitDeleted = deletedListener as unknown as (change: { sessionId: string }) => void | Promise<void>;
    const emitRevoked = revokedListener as unknown as (change: { sessionId: string }) => void | Promise<void>;
    const emitReset = resetListener as unknown as (change: { cursor: number }) => void | Promise<void>;
    await emitDeleted({ sessionId: 'deleted-before-worker-start' });
    await emitRevoked({ sessionId: 'revoked-before-worker-start' });
    await emitReset({ cursor: 11 });
    expect(removeSessions.mock.calls).toEqual([
      [['deleted-before-worker-start']],
      [['revoked-before-worker-start']],
    ]);
    expect(memoryWorker.reconcileRetainedSessionAccess).toHaveBeenCalledOnce();
  });
});
