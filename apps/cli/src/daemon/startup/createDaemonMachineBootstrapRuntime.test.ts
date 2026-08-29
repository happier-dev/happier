import { describe, expect, it, vi } from 'vitest';

import {
  SessionServerStartIngressRequestV1Schema,
  type MachineLiveStreamFrameV1,
} from '@happier-dev/protocol';

import type { MachineLiveStreamCaptureAdapter } from '../peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import type {
  AutomationWorkerHandle,
  startAutomationWorker,
} from '../automation/automationWorker';
import { cleanupAndShutdown } from '../lifecycle/cleanupAndShutdown';

import { createDaemonMachineBootstrapRuntime } from './createDaemonMachineBootstrapRuntime';

const automationWorkerMocks = vi.hoisted(() => ({
  startAutomationWorker: vi.fn(),
}));
const voiceInferenceWorkerMocks = vi.hoisted(() => ({
  startVoiceInferenceWorker: vi.fn(async () => ({ stop: vi.fn(async () => {}) })),
}));

vi.mock('../automation/automationWorker', () => ({
  startAutomationWorker: automationWorkerMocks.startAutomationWorker,
}));
vi.mock('../voiceInference/voiceInferenceWorker', () => ({
  startVoiceInferenceWorker: voiceInferenceWorkerMocks.startVoiceInferenceWorker,
}));

const deviceLocalSecretStorage = {
  sealJson: vi.fn(() => 'sealed'),
  openJson: vi.fn(() => null),
  deriveOpaqueIdentity: vi.fn(() => 'a'.repeat(64)),
} as never;

function createBaseRuntimeParams(overrides: Partial<Parameters<typeof createDaemonMachineBootstrapRuntime>[0]> = {}) {
  return {
    // Test fixture boundary: this test only inspects returned PMS config; API methods are not invoked.
    api: {
      machineSyncClient: vi.fn(),
    } as never,
    credentials: {
      token: 'token',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    },
    deviceLocalSecretStorage,
    diagnosticSubsystemGates: {
      disableMachineSync: false,
      disableAutomationWorker: false,
    },
    runtimeId: 'runtime_1',
    publicReleaseChannel: 'dev' as const,
    startupSource: 'manual',
    serviceLabel: undefined,
    transferRuntimeStatePublisher: null,
    spawnSession: vi.fn(),
    stopSession: vi.fn(),
    awaitAgentSessionOpen: vi.fn(),
    isSessionAlreadyRunning: vi.fn(),
    loadLocalSessionMetadataForHandoff: vi.fn(),
    savePreparedTargetLocalMetadata: vi.fn(),
    beforeShutdown: vi.fn(),
    requestShutdown: vi.fn(),
    directPeerServerLifecycle: null,
    // Test fixture boundary: transfer registries are pass-through values and are not invoked by this test.
    directTransferPromptAssetAdapterRegistry: {} as never,
    directTransferPromptRegistryRegistry: {} as never,
    daemonServerWorkScheduler: {} as never,
    setDaemonServerWorkOnline: vi.fn(),
    onMachineConnectionOnline: vi.fn(),
    reconcileConnectedServicesProjection: vi.fn(),
    isShuttingDown: () => false,
    ...overrides,
  } satisfies Parameters<typeof createDaemonMachineBootstrapRuntime>[0];
}

describe('createDaemonMachineBootstrapRuntime', () => {
  it('does not start the daemon inference worker while its canonical feature decision is disabled', async () => {
    const previous = process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED;
    delete process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED;
    try {
      const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams());
      await expect(runtime.startVoiceInferenceWorkerForMachine('machine_1', 'account_1'))
        .resolves.toBeNull();
      expect(voiceInferenceWorkerMocks.startVoiceInferenceWorker).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED;
      else process.env.HAPPIER_FEATURE_VOICE_DAEMON_INFERENCE__ENABLED = previous;
    }
  });

  it('keeps daemon quiescence out of ownership metadata and forwards it as a lifecycle dependency', () => {
    const machineSyncClient = vi.fn(() => ({}));
    const isShuttingDown = vi.fn(() => false);
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      // Test fixture boundary: only machineSyncClient call arguments are observed.
      api: { machineSyncClient } as never,
      isShuttingDown,
    }));
    expect(runtime.deviceLocalSecretStorage).toBe(
      deviceLocalSecretStorage,
    );
    const machine = {
      id: 'machine_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy' as const,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    runtime.createConnectedApiMachine(machine);

    expect(machineSyncClient).toHaveBeenCalledWith(
      machine,
      expect.not.objectContaining({ isDaemonQuiescing: expect.any(Function) }),
      { isDaemonQuiescing: isShuttingDown },
    );
  });

  it('forwards the daemon-owned inventory snapshot reader without creating a second scanner', () => {
    const readLocalServiceInventorySnapshot = vi.fn();
    const getServerFeaturesSnapshot = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      readLocalServiceInventorySnapshot,
      getServerFeaturesSnapshot,
    }));
    expect(runtime.readLocalServiceInventorySnapshot).toBe(readLocalServiceInventorySnapshot);
    expect(runtime.getServerFeaturesSnapshot).toBe(getServerFeaturesSnapshot);
  });

  it('forwards the durable connected-services projection reconciler into machine cursor composition', () => {
    const reconcileConnectedServicesProjection = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      reconcileConnectedServicesProjection,
    }));

    expect(runtime.reconcileConnectedServicesProjection).toBe(reconcileConnectedServicesProjection);
  });

  it('forwards the daemon runtime-open attestation reader into machine bootstrap', () => {
    const awaitAgentSessionOpen = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      awaitAgentSessionOpen,
    }));

    expect(runtime.awaitAgentSessionOpen).toBe(awaitAgentSessionOpen);
  });

  it('does not publish an automation worker when the diagnostic gate disables it', () => {
    const onAutomationWorkerStarted = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      diagnosticSubsystemGates: {
        disableMachineSync: false,
        disableAutomationWorker: true,
      },
      onAutomationWorkerStarted,
    }));

    expect(runtime.startAutomationWorkerForMachine('machine_1')).toBeNull();
    expect(onAutomationWorkerStarted).not.toHaveBeenCalled();
  });

  it('publishes the worker to shutdown ownership before downstream bootstrap can continue', async () => {
    const worker: AutomationWorkerHandle = {
      stop: vi.fn(),
      refreshAssignments: vi.fn(async () => {}),
      pause: vi.fn(),
      resume: vi.fn(),
      handleServerUpdate: vi.fn(),
    };
    automationWorkerMocks.startAutomationWorker.mockReturnValueOnce(worker);
    let shutdownOwnedWorker: AutomationWorkerHandle | null = null;
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      onAutomationWorkerStarted: (startedWorker) => {
        shutdownOwnedWorker = startedWorker;
      },
    }));

    const startedWorker = runtime.startAutomationWorkerForMachine('machine_1');
    expect(startedWorker).toBe(worker);
    expect(shutdownOwnedWorker).toBe(worker);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(
      (() => undefined as never) as typeof process.exit,
    );
    try {
      // This is the barrier between factory publication and the next bootstrap
      // action (Memory/onMachineSyncRuntime). Shutdown must retain this exact
      // early handle rather than wait for the later runtime result.
      await cleanupAndShutdown({
        source: 'happier-cli',
        processEnv: {},
        resolvePositiveIntEnv: (_raw, fallback) => fallback,
        restartOnStaleVersionAndHeartbeat: null,
        connectedServiceRefreshLoopHandle: null,
        connectedServiceQuotasLoopHandle: null,
        apiMachine: null,
        machineConnectionStateCleanup: null,
        automationWorker: shutdownOwnedWorker,
        memoryWorker: null,
        voiceInferenceWorker: null,
        trackedSessionCount: 0,
        stopDirectPeerServer: async () => {},
        stopTailscaleTransferServeLifecycle: async () => {},
        stopControlServer: async () => {},
        stopCaffeinate: async () => {},
        daemonLockHandle: null,
        releaseDaemonLock: async () => {},
      });
      expect(worker.stop).toHaveBeenCalledOnce();
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('supplies the connected Session-start ingress to the Automation worker', async () => {
    const worker: AutomationWorkerHandle = {
      stop: vi.fn(),
      refreshAssignments: vi.fn(async () => {}),
      pause: vi.fn(),
      resume: vi.fn(),
      handleServerUpdate: vi.fn(),
    };
    const dispatched = {
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'session-automation',
      executionTarget: { serverId: 'server-1', machineId: 'machine_1' },
      organizationPlacement: { folderId: null, tagIds: [] },
      initialInput: { status: 'accepted' as const, localId: 'automation:run:run-1' },
    };
    const dispatchSessionServerStart = vi.fn(async () => dispatched);
    const connectedApiMachine = {
      enqueueSessionPendingByMachine: vi.fn(),
      dispatchSessionServerStart,
    };
    const machineSyncClient = vi.fn(() => connectedApiMachine);
    automationWorkerMocks.startAutomationWorker.mockReturnValueOnce(worker);
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      api: { machineSyncClient } as never,
    }));
    const machine = {
      id: 'machine_1',
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'legacy' as const,
      metadata: null,
      metadataVersion: 0,
      daemonState: null,
      daemonStateVersion: 0,
    };

    runtime.createConnectedApiMachine(machine);
    runtime.startAutomationWorkerForMachine(machine.id);

    const workerParams = automationWorkerMocks.startAutomationWorker.mock.calls.at(-1)?.[0] as
      | Parameters<typeof startAutomationWorker>[0]
      | undefined;
    const request = SessionServerStartIngressRequestV1Schema.parse({
      v: 1,
      kind: 'session.serverStart.ingress',
      runId: 'run-1',
      attempt: 1,
      requestEnvelope: {
        t: 'plain',
        v: {
          creationKey: 'automation-run:run-1',
          executionTarget: { serverId: 'server-1', machineId: 'machine_1' },
          directory: '/workspace/project',
          organizationPlacement: { folderId: null, tagIds: [] },
          agentTarget: {
            kind: 'agent',
            identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
          },
          initialMessage: 'Start the automation task.',
        },
      },
    });

    expect(workerParams?.dispatchSessionServerStart).toEqual(expect.any(Function));
    await expect(workerParams?.dispatchSessionServerStart?.(request)).resolves.toEqual(dispatched);
    expect(dispatchSessionServerStart).toHaveBeenCalledWith(request, undefined);
  });

  it('wires the production peer-mediation live-stream capture adapter into machine bootstrap config', () => {
    const cancelConnectedServiceRuntimeAuthRecovery = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      cancelConnectedServiceRuntimeAuthRecovery,
    }));

    expect(runtime.peerMediationMachineRpc?.stream?.captureAdapter).toEqual({
      start: expect.any(Function),
    });
    expect(runtime.cancelConnectedServiceRuntimeAuthRecovery).toBe(cancelConnectedServiceRuntimeAuthRecovery);
  });

  it('uses the shared PMS capture registry for relayed live-stream capture sources', async () => {
    const registry = createMachineLiveStreamCaptureRegistry();
    const offeredFrames: MachineLiveStreamFrameV1[] = [];
    const sourceAdapter: MachineLiveStreamCaptureAdapter = {
      start: async (input) => {
        input.offerFrame({
          v: 1,
          streamId: input.streamId,
          sequence: 1,
          timestampMs: 1_000,
          payloadKind: 'image_keyframe',
          payloadEncoding: 'binary_base64',
          payloadBase64: 'AQID',
          payloadSizeBytes: 3,
        });
        return { ok: true, session: { stop: () => undefined } };
      },
    };
    registry.register({
      sourceId: 'ios-simulator:A1B2-C3D4:screen',
      streamFamily: 'ios-simulator:A1B2-C3D4:screen',
      adapter: sourceAdapter,
      capabilities: {
        v: 1,
        sourceId: 'ios-simulator:A1B2-C3D4:screen',
        sourceKind: 'simulator',
        supportedCodecs: ['image.mjpeg'],
        maxFramesPerSecond: 30,
        inputMode: 'exclusive',
        sidebands: ['capture_health'],
        health: { status: 'available' },
      },
    });

    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      liveStreamCaptureRegistry: registry,
    }));
    const captureAdapter = runtime.peerMediationMachineRpc?.stream?.captureAdapter;
    expect(captureAdapter).toBeDefined();
    if (!captureAdapter) throw new Error('expected live-stream capture adapter');

    const result = await captureAdapter.start({
      streamId: 'stream_1',
      streamFamily: 'ios-simulator:A1B2-C3D4:screen',
      sourceMachineId: 'machine_source',
      targetMachineId: 'machine_target',
      caps: {
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 8_192,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
      },
      startRequest: {
        v: 1,
        streamId: 'stream_1',
        streamFamily: 'ios-simulator:A1B2-C3D4:screen',
        routeKind: 'server_relay',
        sourceMachineId: 'machine_source',
        targetMachineId: 'machine_target',
        maxBitrateBps: 64_000,
        maxFramesPerSecond: 12,
        maxFrameBytes: 8_192,
        maxDurationMs: 60_000,
        maxTotalBytes: 128_000,
      },
      startedAtMs: 1_000,
      expiresAtMs: 61_000,
      nowMs: () => 1_000,
      offerFrame: (frame) => {
        offeredFrames.push(frame);
        return { ok: true };
      },
      applyControl: () => ({ ok: true }),
      emitReceipt: () => undefined,
    });

    expect(result).toMatchObject({ ok: true });
    expect(offeredFrames.map((frame) => frame.sequence)).toEqual([1]);
  });
});
