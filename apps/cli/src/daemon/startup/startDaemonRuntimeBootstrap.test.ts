import { afterEach, describe, expect, it, vi } from 'vitest';

import { startDaemonRuntimeBootstrap } from './startDaemonRuntimeBootstrap';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';

vi.mock('@/persistence', () => ({
  writeDaemonState: vi.fn(),
}));

vi.mock('../connectedServices/quotas/resolveConnectedServicesQuotasDaemonEnabled', () => ({
  resolveConnectedServicesQuotasDaemonEnabled: vi.fn(async () => false),
}));

// K3: capture how the refresh restart handler is wired without standing up the real
// refresh subsystem (network/timers). We only need to inspect the injected
// requestRestartSignal to prove bootstrap wires the GATED adapter (not a raw signal).
const createConnectedServicesAuthUpdatedRestartHandlerMock =
  vi.fn((_params: { requestRestartSignal?: unknown }) => vi.fn());
vi.mock('../connectedServices/refresh/createConnectedServicesAuthUpdatedRestartHandler', () => ({
  createConnectedServicesAuthUpdatedRestartHandler: (params: { requestRestartSignal?: unknown }) =>
    createConnectedServicesAuthUpdatedRestartHandlerMock(params),
}));
vi.mock('../connectedServices/refresh/ConnectedServiceRefreshCoordinator', () => ({
  ConnectedServiceRefreshCoordinator: class {
    constructor(public readonly params: unknown) {}
  },
}));
vi.mock('../connectedServices/refresh/startConnectedServiceRefreshLoop', () => ({
  startConnectedServiceRefreshLoop: vi.fn(() => ({ stop: vi.fn(), pause: vi.fn(), resume: vi.fn() })),
}));

describe('startDaemonRuntimeBootstrap', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('creates daemon server-work with a connection gate and logger', async () => {
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    vi.stubEnv('HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED', 'false');
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    const result = await startDaemonRuntimeBootstrap({
      api: {} as never,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      },
      logger,
      processEnv: {
        HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'false',
      },
      controlPort: 41234,
      machineId: 'machine-1',
      machineIdProvider: () => 'machine-1',
      runtimeId: 'runtime-1',
      cliVersion: '0.0.0-test',
      startupSource: 'manual',
      serviceLabel: undefined,
      daemonLogPath: '/tmp/happier-daemon.log',
      controlToken: 'control-token',
      happyHomeDir: '/tmp/happy-home',
      activeServerDir: '/tmp/happy-active-server',
      filesystemAccessPolicy: { kind: 'osUser' },
      publicReleaseChannel: 'dev',
      connectedServicesRestartRequestedPids: new Set(),
      pidToTrackedSession: new Map(),
      connectedServiceAuthGroupPreTurnSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({ status: 'session_not_found' as const })),
      },
      requestConnectedServiceRefreshRestartSignal: vi.fn(async () => ({ signaled: true })),
      connectedServiceRuntimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
    });
    const gateHandle = result as typeof result & {
      setDaemonServerWorkOnline?: (online: boolean) => void;
    };

    expect(gateHandle.setDaemonServerWorkOnline).toEqual(expect.any(Function));
    gateHandle.setDaemonServerWorkOnline?.(false);
    const offlineRun = vi.fn(async () => {});
    await expect(result.daemonServerWorkScheduler.enqueue({
      key: 'quota-key',
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      payload: {},
      payloadBytes: 0,
      run: offlineRun,
    })).resolves.toEqual({ status: 'deferred', reason: 'offline' });
    expect(offlineRun).not.toHaveBeenCalled();

    gateHandle.setDaemonServerWorkOnline?.(true);
    const failure = new Error('write failed');
    await expect(result.daemonServerWorkScheduler.enqueue({
      key: 'quota-key-2',
      purpose: 'connectedServiceQuotaPersistence',
      kind: 'latestStateWrite',
      payload: {},
      payloadBytes: 0,
      run: async () => {
        throw failure;
      },
    })).resolves.toMatchObject({
      status: 'failed',
      classification: { retryable: false },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[DAEMON SERVER WORK] Background server work failed',
      expect.objectContaining({
        purpose: 'connectedServiceQuotaPersistence',
        kind: 'latestStateWrite',
        key: 'quota-key-2',
      }),
    );
  });

  it('K3: wires the gated refresh restart adapter into the auth-updated restart handler', async () => {
    vi.stubEnv('HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED', 'false');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const requestConnectedServiceRefreshRestartSignal = vi.fn(async () => ({ signaled: true }));

    await startDaemonRuntimeBootstrap({
      api: { push: () => ({}), listConnectedServiceProfiles: () => ({}) } as never,
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      },
      logger,
      processEnv: {
        // Refresh enabled so the auth-updated restart handler is constructed and wired.
        HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: 'true',
        HAPPIER_CONNECTED_SERVICES_REFRESH_RESTART_PI_ENABLED: 'true',
      },
      controlPort: 41235,
      machineId: 'machine-1',
      machineIdProvider: () => 'machine-1',
      runtimeId: 'runtime-1',
      cliVersion: '0.0.0-test',
      startupSource: 'manual',
      serviceLabel: undefined,
      daemonLogPath: '/tmp/happier-daemon.log',
      controlToken: 'control-token',
      happyHomeDir: '/tmp/happy-home',
      activeServerDir: '/tmp/happy-active-server',
      filesystemAccessPolicy: { kind: 'osUser' },
      publicReleaseChannel: 'dev',
      connectedServicesRestartRequestedPids: new Set(),
      pidToTrackedSession: new Map(),
      connectedServiceAuthGroupPreTurnSwitchCoordinator: {
        switchBeforeTurn: vi.fn(async () => ({ status: 'session_not_found' as const })),
      },
      requestConnectedServiceRefreshRestartSignal,
      connectedServiceRuntimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
    });

    // The refresh restart handler must be wired with the GATED adapter (turn-deferral +
    // reachability), not a raw SIGTERM signal — this is the K3 fix.
    expect(createConnectedServicesAuthUpdatedRestartHandlerMock).toHaveBeenCalledTimes(1);
    const handlerParams = createConnectedServicesAuthUpdatedRestartHandlerMock.mock.calls[0]?.[0];
    expect(handlerParams?.requestRestartSignal).toBe(requestConnectedServiceRefreshRestartSignal);
  });
});
