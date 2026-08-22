import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  authAndSetupMachineIfNeeded: vi.fn(),
  createApiClient: vi.fn(),
  ensureMachineRegistered: vi.fn(),
  getPreferredHostName: vi.fn(),
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(),
  stopDaemon: vi.fn(),
  readOrCreateDeviceLocalSecretStorage: vi.fn(),
  startCaffeinate: vi.fn(),
  acquireDaemonLock: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: mocks.authAndSetupMachineIfNeeded,
}));

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: mocks.createApiClient,
  },
}));

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: mocks.ensureMachineRegistered,
}));

vi.mock('@/integrations/caffeinate', () => ({
  startCaffeinate: mocks.startCaffeinate,
}));

vi.mock('@/persistence', () => ({
  acquireDaemonLock: mocks.acquireDaemonLock,
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
  },
}));

vi.mock('../machine/metadata', () => ({
  getPreferredHostName: mocks.getPreferredHostName,
}));

vi.mock('../controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: mocks.isDaemonRunningCurrentlyInstalledHappyVersion,
  stopDaemon: mocks.stopDaemon,
}));

vi.mock('../deviceLocalSecretStorage', () => ({
  readOrCreateDeviceLocalSecretStorage: mocks.readOrCreateDeviceLocalSecretStorage,
}));

describe('prepareDaemonBootstrapContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authAndSetupMachineIfNeeded.mockResolvedValue({
      credentials: { token: 'token', encryption: { key: 'enc' } },
      machineId: 'machine-1',
    });
    mocks.createApiClient.mockResolvedValue({ api: true });
    mocks.ensureMachineRegistered.mockResolvedValue({
      machineId: 'machine-1',
      didRotateMachineId: false,
    });
    mocks.getPreferredHostName.mockResolvedValue('host.local');
    mocks.isDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true);
    mocks.readOrCreateDeviceLocalSecretStorage.mockResolvedValue({
      sealJson: vi.fn(),
      openJson: vi.fn(),
    });
    mocks.startCaffeinate.mockReturnValue(false);
  });

  it('lets a self-restart replacement continue takeover without synchronous machine preflight', async () => {
    const { prepareDaemonBootstrapContext } = await import('./prepareDaemonBootstrapContext');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as never);

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-daemon-bootstrap-'));
    const lockHandle = await open(join(tempDir, 'daemon.lock'), 'w');
    try {
      const result = await prepareDaemonBootstrapContext({
        daemonLockHandle: lockHandle,
        initialMachineMetadata: { platform: 'darwin' } as never,
        startupSource: 'self-restart',
      });

      expect(result.daemonLockHandle).toBe(lockHandle);
      expect(result.machineId).toBe('machine-1');
      expect(result.preflightMachineRegistration).toBeNull();
      expect(mocks.ensureMachineRegistered).not.toHaveBeenCalled();
      expect(mocks.stopDaemon).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      await lockHandle.close().catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not ask the control client to stop the startup process after it owns the daemon lock', async () => {
    const { prepareDaemonBootstrapContext } = await import('./prepareDaemonBootstrapContext');
    mocks.isDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false);

    const tempDir = await mkdtemp(join(tmpdir(), 'happier-daemon-bootstrap-owned-lock-'));
    const lockHandle = await open(join(tempDir, 'daemon.lock'), 'w');
    try {
      const result = await prepareDaemonBootstrapContext({
        daemonLockHandle: lockHandle,
        initialMachineMetadata: { platform: 'darwin' } as never,
        startupSource: 'manual',
      });

      expect(result.daemonLockHandle).toBe(lockHandle);
      expect(mocks.stopDaemon).not.toHaveBeenCalled();
      expect(mocks.acquireDaemonLock).not.toHaveBeenCalled();
    } finally {
      await lockHandle.close().catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('still stops a mismatched incumbent before acquiring startup ownership', async () => {
    const { prepareDaemonBootstrapContext } = await import('./prepareDaemonBootstrapContext');
    mocks.isDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false);
    const acquiredLock = { kind: 'acquired-lock' };
    mocks.acquireDaemonLock.mockResolvedValue(acquiredLock);

    const result = await prepareDaemonBootstrapContext({
      daemonLockHandle: null,
      initialMachineMetadata: { platform: 'darwin' } as never,
      startupSource: 'manual',
    });

    expect(mocks.stopDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.acquireDaemonLock).toHaveBeenCalledWith(5, 200);
    expect(mocks.stopDaemon.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acquireDaemonLock.mock.invocationCallOrder[0]!,
    );
    expect(result.daemonLockHandle).toBe(acquiredLock);
  });
});
