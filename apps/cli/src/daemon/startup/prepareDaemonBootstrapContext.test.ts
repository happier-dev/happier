import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import fastify from 'fastify';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { artifactKindListResponse } from '@/testkit/http/artifactHome';
import { prepareDaemonBootstrapContext } from './prepareDaemonBootstrapContext';

const mocks = vi.hoisted(() => ({
  authAndSetupMachineIfNeeded: vi.fn(),
  authAndPrepareDaemonMachineIfNeeded: vi.fn(),
  createApiClient: vi.fn(),
  ensureMachineRegistered: vi.fn(),
  getPreferredHostName: vi.fn(),
  isDaemonRunningCurrentlyInstalledHappyVersion: vi.fn(),
  inspectDaemonRunningStateAndCleanupStaleState: vi.fn(),
  stopDaemon: vi.fn(),
  readOrCreateDeviceLocalSecretStorage: vi.fn(),
  acquireDaemonLock: vi.fn(),
  readStoredCredentials: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: mocks.authAndSetupMachineIfNeeded,
  authAndPrepareDaemonMachineIfNeeded: mocks.authAndPrepareDaemonMachineIfNeeded,
}));

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: mocks.createApiClient,
  },
}));

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: mocks.ensureMachineRegistered,
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/persistence')>()),
  acquireDaemonLock: mocks.acquireDaemonLock,
  readStoredCredentials: mocks.readStoredCredentials,
}));

import { CliReloginRequiredError } from '@/persistence';

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
    // The background approval passes report on the default info/warn file paths.
    infoFile: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../machine/metadata', () => ({
  getPreferredHostName: mocks.getPreferredHostName,
}));

vi.mock('../controlClient', () => ({
  isDaemonRunningCurrentlyInstalledHappyVersion: mocks.isDaemonRunningCurrentlyInstalledHappyVersion,
  inspectDaemonRunningStateAndCleanupStaleState: mocks.inspectDaemonRunningStateAndCleanupStaleState,
  stopDaemon: mocks.stopDaemon,
}));

vi.mock('../deviceLocalSecretStorage', () => ({
  readOrCreateDeviceLocalSecretStorage: mocks.readOrCreateDeviceLocalSecretStorage,
}));

describe('prepareDaemonBootstrapContext', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Recovery's real Artifact owner sees an empty remote queue. Only HTTP is
    // substituted; these startup tests must never contact an ambient Home.
    const app = fastify();
    app.get('/v1/artifacts', async () => artifactKindListResponse([]));
    await app.ready();
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: new URL(configuration.apiServerUrl).origin });
    onTestFinished(async () => { restoreHttp(); await app.close(); });
    mocks.authAndPrepareDaemonMachineIfNeeded.mockResolvedValue({
      credentials: { token: 'token', encryption: { key: 'enc' } },
      machineId: 'machine-1',
    });
    mocks.readStoredCredentials.mockResolvedValue({
      token: 'persisted-token',
      encryption: { key: 'persisted-enc' },
    });
    mocks.createApiClient.mockResolvedValue({ api: true, setLocalMachineId: vi.fn() });
    mocks.ensureMachineRegistered.mockResolvedValue({
      machineId: 'machine-1',
      didRotateMachineId: false,
    });
    mocks.getPreferredHostName.mockResolvedValue('host.local');
    mocks.isDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(true);
    mocks.inspectDaemonRunningStateAndCleanupStaleState.mockResolvedValue({
      status: 'running',
      state: { pid: 1234 },
    });
    mocks.readOrCreateDeviceLocalSecretStorage.mockResolvedValue({
      sealJson: vi.fn(),
      openJson: vi.fn(),
    });
  });

  it('lets a self-restart replacement continue takeover without synchronous machine preflight', async () => {
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
      expect(result.api.setLocalMachineId).toHaveBeenCalledWith('machine-1');
    } finally {
      await lockHandle.close().catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('prepares a persisted trusted Home transport before fresh daemon authentication and API construction', async () => {
    const order: string[] = [];
    mocks.authAndPrepareDaemonMachineIfNeeded.mockImplementation(async () => {
      order.push('auth');
      return {
        credentials: { token: 'token', encryption: { key: 'enc' } },
        machineId: 'machine-1',
      };
    });
    mocks.createApiClient.mockImplementation(async () => {
      order.push('api');
      return { api: true, setLocalMachineId: vi.fn() };
    });
    mocks.isDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false);
    mocks.acquireDaemonLock.mockResolvedValue({ kind: 'acquired-lock' });

    await prepareDaemonBootstrapContext({
      daemonLockHandle: null,
      initialMachineMetadata: { platform: 'darwin' } as never,
      startupSource: 'manual',
      prepareServerTransport: async ({ persistedCredentials }) => {
        expect(persistedCredentials?.token).toBe('persisted-token');
        order.push('transport');
      },
    });

    expect(order).toEqual(['transport', 'auth', 'api']);
  });

  it.each([
    ['missing', null],
    ['obsolete', new CliReloginRequiredError()],
  ] as const)('prepares trusted transport and authenticates when credentials are %s', async (_state, refusal) => {
    if (refusal) mocks.readStoredCredentials.mockRejectedValueOnce(refusal);
    else mocks.readStoredCredentials.mockResolvedValue(null);
    mocks.isDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false);
    mocks.acquireDaemonLock.mockResolvedValue({ kind: 'acquired-lock' });
    const order: string[] = [];
    mocks.authAndPrepareDaemonMachineIfNeeded.mockImplementation(async () => {
      order.push('auth');
      return {
        credentials: { token: 'fresh-token', encryption: { key: 'enc' } },
        machineId: 'machine-1',
      };
    });
    mocks.createApiClient.mockImplementation(async () => {
      order.push('api');
      return { api: true, setLocalMachineId: vi.fn() };
    });

    await prepareDaemonBootstrapContext({
      daemonLockHandle: null,
      initialMachineMetadata: { platform: 'darwin' } as never,
      startupSource: 'manual',
      prepareServerTransport: async ({ persistedCredentials }) => {
        expect(persistedCredentials).toBeNull();
        order.push('transport');
      },
      verifyServerTransport: async ({ credentials }) => {
        expect(credentials.token).toBe('fresh-token');
        order.push('verify');
      },
    });

    expect(order).toEqual(['transport', 'auth', 'verify', 'api']);
  });

  it('does not ask the control client to stop the startup process after it owns the daemon lock', async () => {
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

  it('uses a rotated preflight only for identity recovery and leaves daemon-state registration to startup', async () => {
    mocks.ensureMachineRegistered.mockResolvedValueOnce({
      machineId: 'machine-recovered',
      didRotateMachineId: true,
      machine: { id: 'machine-recovered' },
    });
    const acquiredLock = { kind: 'acquired-lock' };
    mocks.acquireDaemonLock.mockResolvedValue(acquiredLock);

    const result = await prepareDaemonBootstrapContext({
      daemonLockHandle: null,
      initialMachineMetadata: { platform: 'darwin' } as never,
      startupSource: 'manual',
    });

    expect(result.machineId).toBe('machine-recovered');
    expect(result.api.setLocalMachineId).toHaveBeenCalledWith('machine-recovered');
    expect(mocks.stopDaemon).toHaveBeenCalledOnce();
    expect(result.daemonLockHandle).toBe(acquiredLock);
    expect(result.preflightMachineRegistration).toBeNull();
  });

  it('does not stop a daemon whose persisted PID is definitively absent', async () => {
    mocks.isDaemonRunningCurrentlyInstalledHappyVersion.mockResolvedValue(false);
    mocks.inspectDaemonRunningStateAndCleanupStaleState.mockResolvedValue({ status: 'not-running' });
    const acquiredLock = { kind: 'acquired-lock' };
    mocks.acquireDaemonLock.mockResolvedValue(acquiredLock);

    const result = await prepareDaemonBootstrapContext({
      daemonLockHandle: null,
      initialMachineMetadata: { platform: 'darwin' } as never,
      startupSource: 'manual',
    });

    expect(mocks.stopDaemon).not.toHaveBeenCalled();
    expect(mocks.acquireDaemonLock).toHaveBeenCalledWith(5, 200);
    expect(result.daemonLockHandle).toBe(acquiredLock);
  });
});
