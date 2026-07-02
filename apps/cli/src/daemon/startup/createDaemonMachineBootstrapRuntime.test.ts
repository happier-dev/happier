import { describe, expect, it, vi } from 'vitest';

import { createDaemonMachineBootstrapRuntime } from './createDaemonMachineBootstrapRuntime';

describe('createDaemonMachineBootstrapRuntime', () => {
  it('wires the production peer-mediation live-stream capture adapter into machine bootstrap config', () => {
    const runtime = createDaemonMachineBootstrapRuntime({
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
      publicReleaseChannel: 'dev',
      startupSource: 'manual',
      serviceLabel: undefined,
      transferRuntimeStatePublisher: null,
      spawnSession: vi.fn(),
      stopSession: vi.fn(),
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
      isShuttingDown: () => false,
    });

    expect(runtime.peerMediationMachineRpc?.stream?.captureAdapter).toEqual({
      start: expect.any(Function),
    });
  });
});
