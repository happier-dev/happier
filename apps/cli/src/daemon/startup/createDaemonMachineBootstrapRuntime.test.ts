import { describe, expect, it, vi } from 'vitest';

import type { MachineLiveStreamFrameV1 } from '@happier-dev/protocol';

import type { MachineLiveStreamCaptureAdapter } from '../peer/mediation/stream/captureAdapter';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';

import { createDaemonMachineBootstrapRuntime } from './createDaemonMachineBootstrapRuntime';

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
  it('keeps daemon quiescence out of ownership metadata and forwards it as a lifecycle dependency', () => {
    const machineSyncClient = vi.fn(() => ({}));
    const isShuttingDown = vi.fn(() => false);
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      // Test fixture boundary: only machineSyncClient call arguments are observed.
      api: { machineSyncClient } as never,
      isShuttingDown,
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

    expect(machineSyncClient).toHaveBeenCalledWith(
      machine,
      expect.not.objectContaining({ isDaemonQuiescing: expect.any(Function) }),
      { isDaemonQuiescing: isShuttingDown },
    );
  });

  it('forwards the daemon-owned inventory snapshot reader without creating a second scanner', () => {
    const readLocalServiceInventorySnapshot = vi.fn();
    const dispatchProviderLocalServicesBridge = vi.fn();
    const readManagedLocalServicesSnapshot = vi.fn();
    const getServerFeaturesSnapshot = vi.fn();
    const runtime = createDaemonMachineBootstrapRuntime(createBaseRuntimeParams({
      readLocalServiceInventorySnapshot,
      dispatchProviderLocalServicesBridge,
      readManagedLocalServicesSnapshot,
      getServerFeaturesSnapshot,
    }));
    expect(runtime.readLocalServiceInventorySnapshot).toBe(readLocalServiceInventorySnapshot);
    expect(runtime.dispatchProviderLocalServicesBridge).toBe(dispatchProviderLocalServicesBridge);
    expect(runtime.readManagedLocalServicesSnapshot).toBe(readManagedLocalServicesSnapshot);
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
