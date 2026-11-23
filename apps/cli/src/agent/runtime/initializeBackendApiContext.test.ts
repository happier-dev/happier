import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credentials } from '@/persistence';
import { reloadConfiguration } from '@/configuration';
import { updateMachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { MachineMetadata } from '@/api/types';

const createApiClient = vi.fn();
const ensureMachineRegisteredMock = vi.fn();
const readDaemonStateMock = vi.fn();

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: createApiClient,
  },
}));

vi.mock('@/api/machine/ensureMachineRegistered', () => ({
  ensureMachineRegistered: ensureMachineRegisteredMock,
}));

vi.mock('@/persistence', () => ({
  readDaemonState: readDaemonStateMock,
}));

describe('initializeBackendApiContext', () => {
  const credentials: Credentials = {
    token: 'token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
  const machineMetadata: MachineMetadata = {
    host: 'test-host',
    platform: 'darwin',
    happyCliVersion: '0.0.0-test',
    homeDir: '/tmp/home',
    happyHomeDir: '/tmp/home/.happier',
    happyLibDir: '/tmp/home/.happier/lib',
  };

  beforeEach(async () => {
    createApiClient.mockReset();
    ensureMachineRegisteredMock.mockReset();
    readDaemonStateMock.mockReset();
    const homeDir = await createTempDir('happier-backend-api-context-');
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    env.patch({ HAPPIER_HOME_DIR: homeDir });
    reloadConfiguration();
    return async () => {
      env.restore();
      reloadConfiguration();
      await removeTempDir(homeDir);
    };
  });

  it('skips machine registration when explicitly requested', async () => {
    createApiClient.mockResolvedValue({ api: true, setLocalMachineId: vi.fn() });
    await updateMachineRegistration(() => ({ machineId: 'machine-original' }));

    const { initializeBackendApiContext } = await import('./initializeBackendApiContext');
    const params = {
      credentials,
      machineMetadata,
      skipMachineRegistration: true,
    };

    const result = await initializeBackendApiContext(params);

    expect(result.machineId).toBe('machine-original');
    expect(ensureMachineRegisteredMock).not.toHaveBeenCalled();
  });

  it('registers machine by default and returns rotated id when provided', async () => {
    createApiClient.mockResolvedValue({ api: true, setLocalMachineId: vi.fn() });
    await updateMachineRegistration(() => ({ machineId: 'machine-original' }));
    readDaemonStateMock.mockResolvedValue(null);
    ensureMachineRegisteredMock.mockResolvedValue({ machineId: 'machine-rotated' });

    const { initializeBackendApiContext } = await import('./initializeBackendApiContext');

    const result = await initializeBackendApiContext({
      credentials,
      machineMetadata,
    });

    expect(ensureMachineRegisteredMock).toHaveBeenCalledTimes(1);
    expect(result.machineId).toBe('machine-rotated');
  });

  it('records the resolved runtime machine id on the API client', async () => {
    const api = { setLocalMachineId: vi.fn() };
    createApiClient.mockResolvedValue(api);
    await updateMachineRegistration(() => ({ machineId: 'machine-original' }));
    readDaemonStateMock.mockResolvedValue(null);
    ensureMachineRegisteredMock.mockResolvedValue({ machineId: 'machine-rotated' });

    const { initializeBackendApiContext } = await import('./initializeBackendApiContext');

    const result = await initializeBackendApiContext({
      credentials,
      machineMetadata,
    });

    expect(result.api).toBe(api);
    expect(result.machineId).toBe('machine-rotated');
    expect(api.setLocalMachineId).toHaveBeenCalledWith('machine-rotated');
  });

  it('skips machine registration when daemon is already running', async () => {
    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    createApiClient.mockResolvedValue({ api: true, setLocalMachineId: vi.fn() });
    await updateMachineRegistration(() => ({ machineId: 'machine-original' }));
    readDaemonStateMock.mockResolvedValue({ pid: 12345 });

    try {
      const { initializeBackendApiContext } = await import('./initializeBackendApiContext');
      const result = await initializeBackendApiContext({
        credentials,
        machineMetadata,
      });

      expect(processKillSpy).toHaveBeenCalledWith(12345, 0);
      expect(ensureMachineRegisteredMock).not.toHaveBeenCalled();
      expect(result.machineId).toBe('machine-original');
    } finally {
      processKillSpy.mockRestore();
    }
  });
});
