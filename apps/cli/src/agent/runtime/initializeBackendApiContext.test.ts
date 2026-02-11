import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credentials } from '@/persistence';
import type { MachineMetadata } from '@/api/types';

const createApiClient = vi.fn();
const ensureMachineRegisteredMock = vi.fn();
const readSettingsMock = vi.fn();
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
  readSettings: readSettingsMock,
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

  beforeEach(() => {
    createApiClient.mockReset();
    ensureMachineRegisteredMock.mockReset();
    readSettingsMock.mockReset();
    readDaemonStateMock.mockReset();
  });

  it('skips machine registration when explicitly requested', async () => {
    createApiClient.mockResolvedValue({ api: true });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-original' });

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
    createApiClient.mockResolvedValue({ api: true });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-original' });
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

  it('skips machine registration when daemon is already running', async () => {
    const processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    createApiClient.mockResolvedValue({ api: true });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-original' });
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
