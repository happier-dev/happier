import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Credentials, Settings } from '@/persistence';
import type { ActiveServerStoredTokenValidationResult } from '@/auth/validateStoredAuthTokenAgainstActiveServer';

const authAndSetupMachineIfNeededMock = vi.hoisted(() => vi.fn(async () => ({
  machineId: 'm1',
  credentials: { token: 't1', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
})));
const validateStoredAuthTokenAgainstActiveServerMock = vi.hoisted(() =>
  vi.fn<(token: string) => Promise<ActiveServerStoredTokenValidationResult>>(async () => ({ state: 'valid', httpStatus: 200 })),
);
const readCredentialsMock = vi.hoisted(() => vi.fn<() => Promise<Credentials | null>>(async () => null));
const readSettingsMock = vi.hoisted(() => vi.fn<() => Promise<Partial<Settings>>>(async () => ({})));
const clearCredentialsMock = vi.hoisted(() => vi.fn(async () => {}));
const clearMachineIdMock = vi.hoisted(() => vi.fn(async () => {}));
const stopDaemonMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: () => authAndSetupMachineIfNeededMock(),
}));

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer: (token: string) => validateStoredAuthTokenAgainstActiveServerMock(token),
}));

vi.mock('@/server/serverSelection', () => ({
  applyServerSelectionFromArgs: async (args: string[]) => args,
}));

vi.mock('@/persistence', () => ({
  readCredentials: () => readCredentialsMock(),
  readSettings: () => readSettingsMock(),
  clearCredentials: () => clearCredentialsMock(),
  clearMachineId: () => clearMachineIdMock(),
}));

vi.mock('@/daemon/controlClient', () => ({
  stopDaemon: () => stopDaemonMock(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

describe('happier auth login --print-configure-links', () => {
  const prev = process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS;

  beforeEach(() => {
    // This test relies on per-file module mocks; ensure we never reuse a cached login module
    // from a prior test file executed in the same forked worker.
    vi.resetModules();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS;
    else process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS = prev;
    authAndSetupMachineIfNeededMock.mockReset();
    authAndSetupMachineIfNeededMock.mockResolvedValue({
      machineId: 'm1',
      credentials: { token: 't1', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
    });
    validateStoredAuthTokenAgainstActiveServerMock.mockReset();
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({ state: 'valid', httpStatus: 200 });
    readCredentialsMock.mockReset();
    readCredentialsMock.mockResolvedValue(null);
    readSettingsMock.mockReset();
    readSettingsMock.mockResolvedValue({});
    clearCredentialsMock.mockReset();
    clearMachineIdMock.mockReset();
    stopDaemonMock.mockReset();
    vi.resetModules();
  });

  it('sets HAPPIER_AUTH_PRINT_CONFIGURE_LINKS=1 when flag is present', async () => {
    delete process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--print-configure-links']);
      expect(process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS).toBe('1');
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('does not set HAPPIER_AUTH_PRINT_CONFIGURE_LINKS when flag is absent', async () => {
    delete process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);
      expect(process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS).toBeUndefined();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('repairs rejected stored credentials instead of reporting already authenticated', async () => {
    readCredentialsMock.mockResolvedValue({
      token: 'stale-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({
      state: 'invalid',
      httpStatus: 401,
      reasonCode: 'not_authenticated',
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);

      expect(validateStoredAuthTokenAgainstActiveServerMock).toHaveBeenCalledWith('stale-token');
      expect(stopDaemonMock).toHaveBeenCalledTimes(1);
      expect(clearCredentialsMock).toHaveBeenCalledTimes(1);
      expect(clearMachineIdMock).toHaveBeenCalledTimes(1);
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledTimes(1);
      expect(consoleSpy).not.toHaveBeenCalledWith(expect.stringContaining('Already authenticated'));
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
