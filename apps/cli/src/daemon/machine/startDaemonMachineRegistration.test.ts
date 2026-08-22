import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiMachineClient } from '@/api/apiMachine';
import type { Machine, MachineMetadata } from '@/api/types';
import { createDeferred } from '@/testkit/async/deferred';
import { cleanupAndShutdown } from '../lifecycle/cleanupAndShutdown';
import type { AutomationWorkerHandle } from '../automation/automationWorker';
import type { DaemonSessionMutationCustody } from '../connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import type { MemoryWorkerHandle } from '../memory/memoryWorker';
import { createPromptAssetAdapterRegistry } from '@/prompts/assets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/prompts/registries/createPromptRegistryAdapterRegistry';
import { DEFAULT_MEMORY_SETTINGS } from '@/settings/memorySettings';

import { ensureMachineRegistered } from '@/api/machine/ensureMachineRegistered';
import { MachineContentPublicKeyMismatchError } from '@/api/machine/machineRegistrationErrors';
import { startDaemonMachineRegistration } from './startDaemonMachineRegistration';
import type { BootstrapMachineSyncRuntimeResult } from './bootstrapMachineSyncRuntime';

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: vi.fn(),
}));

const metadataForRegistration = {
  host: 'test-host',
  platform: 'test-platform',
  happyCliVersion: '0.0.0-test',
  homeDir: '/tmp/home',
  happyHomeDir: '/tmp/happy',
  happyLibDir: '/tmp/happy/lib',
} satisfies MachineMetadata;

function createMachine(id: string): Machine {
  return {
    id,
    encryptionMode: 'plain',
    metadata: null,
    metadataVersion: 0,
    daemonState: null,
    daemonStateVersion: 0,
  };
}

function requireMachineSyncRuntime(
  runtime: BootstrapMachineSyncRuntimeResult | null,
): BootstrapMachineSyncRuntimeResult {
  if (!runtime) throw new Error('expected successful machine sync runtime');
  return runtime;
}

describe('startDaemonMachineRegistration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(ensureMachineRegistered).mockReset();
  });

  it('retires every failed bootstrap attempt before retrying and leaves only the successful worker for shutdown', async () => {
    const shutdown = createDeferred<void>();
    const initialMachine = createMachine('machine-1');
    const events: string[] = [];
    const workers: AutomationWorkerHandle[] = [];
    const apiMachines: Array<{
      shutdown: ReturnType<typeof vi.fn>;
      updateDaemonState: ReturnType<typeof vi.fn>;
    }> = [];
    const memoryWorkers: MemoryWorkerHandle[] = [];
    const sharedMutationCustody: DaemonSessionMutationCustody = {
      bindRecoveredJournals: vi.fn(async () => ({ boundSessionIds: [], retainedSessionIds: [] })),
      close: vi.fn(async () => {}),
      stage: vi.fn(async () => {}),
      stageTranscriptEvent: vi.fn(async () => ({ persisted: true as const, delivered: true })),
    };
    let automationAttempt = 0;
    let memoryAttempt = 0;

    const createConnectedApiMachine = vi.fn(() => {
      const attempt = apiMachines.length + 1;
      const apiMachine = {
        setRPCHandlers: vi.fn(() => ({ externalSessionPluginAdmissionOwner: undefined })),
        registerLiveStreamRelayRoutes: vi.fn(),
        onUpdate: vi.fn(() => () => {}),
        onAccountSettingsVersionHint: vi.fn(() => () => {}),
        onPendingSessionActivationHint: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        updateDaemonState: vi.fn(async () => 'updated'),
        updateMachineMetadata: vi.fn(async () => 'updated'),
        awaitPendingRpcRequests: vi.fn(async () => {}),
        emitExternalSessionTranscriptUpdate: vi.fn(),
        executeExternalSessionHistoricalImportCommand: vi.fn(async () => ({ ok: true })),
        onMachineTransferEnvelope: vi.fn(() => () => {}),
        sendMachineTransferEnvelope: vi.fn(),
        onTransferRelayV2Envelope: vi.fn(() => () => {}),
        sendTransferRelayV2Envelope: vi.fn(),
        onPeerTcpTunnelRelayEnvelope: vi.fn(() => () => {}),
        sendPeerTcpTunnelRelayEnvelope: vi.fn(),
        onMachineLiveStreamRelayEnvelope: vi.fn(() => () => {}),
        sendMachineLiveStreamRelayEnvelope: vi.fn(),
        getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
          invokeLocal: async () => ({ ok: true }),
        })),
        shutdown: vi.fn(async () => {
          events.push(`api-stopped:${attempt}`);
        }),
      };
      apiMachines.push(apiMachine);
      return apiMachine as unknown as ApiMachineClient;
    });

    const startAutomationWorkerForMachine = vi.fn(() => {
      const attempt = ++automationAttempt;
      const worker: AutomationWorkerHandle = {
        stop: vi.fn(() => {
          events.push(`worker-stopped:${attempt}`);
        }),
        refreshAssignments: vi.fn(async () => {}),
        pause: vi.fn(),
        resume: vi.fn(),
        handleServerUpdate: vi.fn(),
      };
      workers.push(worker);
      events.push(`worker-published:${attempt}`);
      return worker;
    });

    const startMemoryWorkerForMachine = vi.fn(async (): Promise<MemoryWorkerHandle | null> => {
      const attempt = ++memoryAttempt;
      if (attempt <= 2) {
        throw new Error(`memory-bootstrap-failure:${attempt}`);
      }
      const worker: MemoryWorkerHandle = {
        stop: vi.fn(() => {
          events.push(`memory-stopped:${attempt}`);
        }),
        reloadSettings: vi.fn(async () => {}),
        ensureUpToDate: vi.fn(async () => {}),
        getSettings: vi.fn(() => DEFAULT_MEMORY_SETTINGS),
        getEmbeddingsDiagnostics: vi.fn(() => ({ status: 'disabled' } as never)),
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
      memoryWorkers.push(worker);
      return worker;
    });

    vi.mocked(ensureMachineRegistered)
      .mockResolvedValueOnce({ machineId: initialMachine.id, didRotateMachineId: false, machine: initialMachine })
      .mockResolvedValueOnce({ machineId: initialMachine.id, didRotateMachineId: false, machine: initialMachine });

    let successfulRuntime: Awaited<ReturnType<typeof import('./bootstrapMachineSyncRuntime').bootstrapMachineSyncRuntime>> | null = null;
    startDaemonMachineRegistration({
      api: {} as never,
      metadataForRegistration,
      initialDaemonState: { status: 'running' },
      machineRegistrationTimeoutMs: 1_000,
      machineRegistrationRetryBaseDelayMs: 0,
      machineRegistrationRetryMaxDelayMs: 0,
      machineRegistrationRetryJitterMs: 0,
      machineRegistrationMaxAttempts: 3,
      resolvesWhenShutdownRequested: shutdown.promise,
      initialPreflightMachineRegistration: {
        machineId: initialMachine.id,
        didRotateMachineId: false,
        machine: initialMachine,
      },
      resolveMachineId: () => initialMachine.id,
      setMachineId: vi.fn(),
      isShuttingDown: () => false,
      bootstrapRuntime: {
        cliVersion: '0.0.0-test',
        credentials: { token: 'token', encryption: null },
        daemonSessionMutationCustody: sharedMutationCustody,
        preferredHost: 'host.local',
        happyHomeDir: '/tmp/happy-home',
        happyLibDir: '/tmp/happy-lib',
        filesystemAccessPolicy: { kind: 'osUser' },
        takeoverRequested: false,
        isShuttingDown: () => false,
        createConnectedApiMachine,
        attachTransferRuntimeStatePublisher: vi.fn(async () => {}),
        startAutomationWorkerForMachine,
        startMemoryWorkerForMachine,
        startVoiceInferenceWorkerForMachine: vi.fn(async () => null),
        spawnSession: vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' })),
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
      },
      onMachineSyncRuntime: async (runtime) => {
        successfulRuntime = runtime;
      },
    });

    await vi.waitFor(() => expect(successfulRuntime).not.toBeNull());
    expect(events).toEqual([
      'worker-published:1',
      'worker-stopped:1',
      'api-stopped:1',
      'worker-published:2',
      'worker-stopped:2',
      'api-stopped:2',
      'worker-published:3',
    ]);
    expect(workers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(workers[1]?.stop).toHaveBeenCalledTimes(1);
    expect(workers[2]?.stop).not.toHaveBeenCalled();
    expect(requireMachineSyncRuntime(successfulRuntime).automationWorker).toBe(workers[2]);
    expect(sharedMutationCustody.close).not.toHaveBeenCalled();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const runtime = requireMachineSyncRuntime(successfulRuntime);
      await cleanupAndShutdown({
        source: 'happier-cli',
        processEnv: {},
        resolvePositiveIntEnv: (_raw, fallback) => fallback,
        restartOnStaleVersionAndHeartbeat: null,
        connectedServiceRefreshLoopHandle: null,
        connectedServiceQuotasLoopHandle: null,
        apiMachine: runtime.apiMachine,
        closeDaemonMutationCustody: sharedMutationCustody.close,
        machineConnectionStateCleanup: runtime.machineConnectionStateCleanup,
        automationWorker: runtime.automationWorker,
        memoryWorker: runtime.memoryWorker,
        voiceInferenceWorker: runtime.voiceInferenceWorker,
        trackedSessionCount: 0,
        stopDirectPeerServer: runtime.stopPeerMediationLoopbackServer,
        stopTailscaleTransferServeLifecycle: async () => {},
        stopControlServer: async () => {},
        stopCaffeinate: async () => {},
        daemonLockHandle: null,
        releaseDaemonLock: async () => {},
      });
    } finally {
      exitSpy.mockRestore();
      shutdown.resolve();
    }

    expect(workers[2]?.stop).toHaveBeenCalledTimes(1);
    expect(memoryWorkers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(sharedMutationCustody.close).toHaveBeenCalledTimes(1);
  });

  it('retires a returned runtime when handoff rejects before retrying it', async () => {
    const shutdown = createDeferred<void>();
    const initialMachine = createMachine('machine-handoff-retry');
    const handoffFailure = new Error('machine-sync-handoff-failure');
    const cleanupFailure = new MachineContentPublicKeyMismatchError(initialMachine.id, 'cleanup-test');
    const events: string[] = [];
    const workers: AutomationWorkerHandle[] = [];
    const apiMachines: Array<{ shutdown: ReturnType<typeof vi.fn> }> = [];
    const memoryWorkers: MemoryWorkerHandle[] = [];
    const sharedMutationCustody: DaemonSessionMutationCustody = {
      bindRecoveredJournals: vi.fn(async () => ({ boundSessionIds: [], retainedSessionIds: [] })),
      close: vi.fn(async () => {}),
      stage: vi.fn(async () => {}),
      stageTranscriptEvent: vi.fn(async () => ({ persisted: true as const, delivered: true })),
    };

    const createConnectedApiMachine = vi.fn(() => {
      const attempt = apiMachines.length + 1;
      const apiMachine = {
        setRPCHandlers: vi.fn(() => ({ externalSessionPluginAdmissionOwner: undefined })),
        registerLiveStreamRelayRoutes: vi.fn(),
        onUpdate: vi.fn(() => () => {}),
        onAccountSettingsVersionHint: vi.fn(() => () => {}),
        onPendingSessionActivationHint: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        updateDaemonState: vi.fn(async () => 'updated'),
        updateMachineMetadata: vi.fn(async () => 'updated'),
        awaitPendingRpcRequests: vi.fn(async () => {}),
        emitExternalSessionTranscriptUpdate: vi.fn(),
        executeExternalSessionHistoricalImportCommand: vi.fn(async () => ({ ok: true })),
        onMachineTransferEnvelope: vi.fn(() => () => {}),
        sendMachineTransferEnvelope: vi.fn(),
        onTransferRelayV2Envelope: vi.fn(() => () => {}),
        sendTransferRelayV2Envelope: vi.fn(),
        onPeerTcpTunnelRelayEnvelope: vi.fn(() => () => {}),
        sendPeerTcpTunnelRelayEnvelope: vi.fn(),
        onMachineLiveStreamRelayEnvelope: vi.fn(() => () => {}),
        sendMachineLiveStreamRelayEnvelope: vi.fn(),
        getPeerMediationMachineRpcHandlerManager: vi.fn(() => ({
          invokeLocal: async () => ({ ok: true }),
        })),
        shutdown: vi.fn(async () => {
          events.push(`api-stopped:${attempt}`);
        }),
      };
      apiMachines.push(apiMachine);
      return apiMachine as unknown as ApiMachineClient;
    });

    const startAutomationWorkerForMachine = vi.fn(() => {
      const attempt = workers.length + 1;
      const worker: AutomationWorkerHandle = {
        stop: vi.fn(() => {
          events.push(`worker-stopped:${attempt}`);
          if (attempt === 1) throw cleanupFailure;
        }),
        refreshAssignments: vi.fn(async () => {}),
        pause: vi.fn(),
        resume: vi.fn(),
        handleServerUpdate: vi.fn(),
      };
      workers.push(worker);
      events.push(`worker-published:${attempt}`);
      return worker;
    });

    const startMemoryWorkerForMachine = vi.fn(async (): Promise<MemoryWorkerHandle> => {
      const attempt = memoryWorkers.length + 1;
      const worker: MemoryWorkerHandle = {
        stop: vi.fn(() => {
          events.push(`memory-stopped:${attempt}`);
        }),
        reloadSettings: vi.fn(async () => {}),
        ensureUpToDate: vi.fn(async () => {}),
        getSettings: vi.fn(() => DEFAULT_MEMORY_SETTINGS),
        getEmbeddingsDiagnostics: vi.fn(() => ({ status: 'disabled' } as never)),
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
      memoryWorkers.push(worker);
      return worker;
    });

    vi.mocked(ensureMachineRegistered).mockResolvedValueOnce({
      machineId: initialMachine.id,
      didRotateMachineId: false,
      machine: initialMachine,
    });

    let handoffAttempt = 0;
    let successfulRuntime: Awaited<ReturnType<typeof import('./bootstrapMachineSyncRuntime').bootstrapMachineSyncRuntime>> | null = null;
    startDaemonMachineRegistration({
      api: {} as never,
      metadataForRegistration,
      initialDaemonState: { status: 'running' },
      machineRegistrationTimeoutMs: 1_000,
      machineRegistrationRetryBaseDelayMs: 0,
      machineRegistrationRetryMaxDelayMs: 0,
      machineRegistrationRetryJitterMs: 0,
      machineRegistrationMaxAttempts: 2,
      resolvesWhenShutdownRequested: shutdown.promise,
      initialPreflightMachineRegistration: {
        machineId: initialMachine.id,
        didRotateMachineId: false,
        machine: initialMachine,
      },
      resolveMachineId: () => initialMachine.id,
      setMachineId: vi.fn(),
      isShuttingDown: () => false,
      bootstrapRuntime: {
        cliVersion: '0.0.0-test',
        credentials: { token: 'token', encryption: null },
        daemonSessionMutationCustody: sharedMutationCustody,
        preferredHost: 'host.local',
        happyHomeDir: '/tmp/happy-home',
        happyLibDir: '/tmp/happy-lib',
        filesystemAccessPolicy: { kind: 'osUser' },
        takeoverRequested: false,
        isShuttingDown: () => false,
        createConnectedApiMachine,
        attachTransferRuntimeStatePublisher: vi.fn(async () => {}),
        startAutomationWorkerForMachine,
        startMemoryWorkerForMachine,
        startVoiceInferenceWorkerForMachine: vi.fn(async () => null),
        spawnSession: vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' })),
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
      },
      onMachineSyncRuntime: async (runtime) => {
        handoffAttempt += 1;
        if (handoffAttempt === 1) {
          throw handoffFailure;
        }
        successfulRuntime = runtime;
      },
    });

    await vi.waitFor(() => expect(successfulRuntime).not.toBeNull());
    expect(events).toEqual([
      'worker-published:1',
      'worker-stopped:1',
      'memory-stopped:1',
      'api-stopped:1',
      'worker-published:2',
    ]);
    expect(workers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(memoryWorkers[0]?.stop).toHaveBeenCalledTimes(1);
    expect(apiMachines[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(workers[1]?.stop).not.toHaveBeenCalled();
    expect(sharedMutationCustody.close).not.toHaveBeenCalled();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const runtime = requireMachineSyncRuntime(successfulRuntime);
      await cleanupAndShutdown({
        source: 'happier-cli',
        processEnv: {},
        resolvePositiveIntEnv: (_raw, fallback) => fallback,
        restartOnStaleVersionAndHeartbeat: null,
        connectedServiceRefreshLoopHandle: null,
        connectedServiceQuotasLoopHandle: null,
        apiMachine: runtime.apiMachine,
        closeDaemonMutationCustody: sharedMutationCustody.close,
        machineConnectionStateCleanup: runtime.machineConnectionStateCleanup,
        automationWorker: runtime.automationWorker,
        memoryWorker: runtime.memoryWorker,
        voiceInferenceWorker: runtime.voiceInferenceWorker,
        trackedSessionCount: 0,
        stopDirectPeerServer: runtime.stopPeerMediationLoopbackServer,
        stopTailscaleTransferServeLifecycle: async () => {},
        stopControlServer: async () => {},
        stopCaffeinate: async () => {},
        daemonLockHandle: null,
        releaseDaemonLock: async () => {},
      });
    } finally {
      exitSpy.mockRestore();
      shutdown.resolve();
    }

    expect(workers[1]?.stop).toHaveBeenCalledTimes(1);
    expect(memoryWorkers[1]?.stop).toHaveBeenCalledTimes(1);
    expect(apiMachines[1]?.shutdown).toHaveBeenCalledTimes(1);
    expect(sharedMutationCustody.close).toHaveBeenCalledTimes(1);
  });
});
