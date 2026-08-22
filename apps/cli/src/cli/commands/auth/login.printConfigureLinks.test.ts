import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings, StoredCredentials } from '@/persistence';
import type { ActiveServerStoredTokenValidationResult } from '@/auth/validateStoredAuthTokenAgainstActiveServer';

const authAndSetupMachineIfNeededMock = vi.hoisted(() => vi.fn(async () => ({
  machineId: 'm1',
  credentials: { token: 't1', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
})));
const validateStoredAuthTokenAgainstActiveServerMock = vi.hoisted(() =>
  vi.fn<(token: string) => Promise<ActiveServerStoredTokenValidationResult>>(async () => ({ state: 'valid', httpStatus: 200 })),
);
const readStoredCredentialsMock = vi.hoisted(() => vi.fn<() => Promise<StoredCredentials | null>>(async () => null));
const readSettingsMock = vi.hoisted(() => vi.fn<() => Promise<Partial<Settings>>>(async () => ({})));
const clearCredentialsMock = vi.hoisted(() => vi.fn(async () => {}));
const clearMachineIdMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<void>>(async () => {}));
const stopDaemonMock = vi.hoisted(() => vi.fn(async () => {}));
const isDaemonStopIncompleteErrorMock = vi.hoisted(() => vi.fn((error: unknown) => (
  typeof error === 'object'
  && error !== null
  && (error as { code?: unknown }).code === 'daemon_stop_incomplete'
)));

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
  readStoredCredentials: () => readStoredCredentialsMock(),
  readSettings: () => readSettingsMock(),
  clearCredentials: () => clearCredentialsMock(),
  clearMachineId: (opts?: unknown) => clearMachineIdMock(opts),
}));

vi.mock('@/daemon/controlClient', () => ({
  isDaemonStopIncompleteError: (error: unknown) => isDaemonStopIncompleteErrorMock(error),
  stopDaemon: () => stopDaemonMock(),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

function createJwtWithSubject(subject: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: subject })).toString('base64url'),
    '',
  ].join('.');
}

describe('happier auth login --print-configure-links', () => {
  const prev = process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS;
  const prevWaitTimeout = process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS;

  beforeEach(() => {
    // This test relies on per-file module mocks; ensure we never reuse a cached login module
    // from a prior test file executed in the same forked worker.
    vi.resetModules();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS;
    else process.env.HAPPIER_AUTH_PRINT_CONFIGURE_LINKS = prev;
    if (prevWaitTimeout === undefined) delete process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS;
    else process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS = prevWaitTimeout;
    authAndSetupMachineIfNeededMock.mockReset();
    authAndSetupMachineIfNeededMock.mockResolvedValue({
      machineId: 'm1',
      credentials: { token: 't1', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
    });
    validateStoredAuthTokenAgainstActiveServerMock.mockReset();
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({ state: 'valid', httpStatus: 200 });
    readStoredCredentialsMock.mockReset();
    readStoredCredentialsMock.mockResolvedValue(null);
    readSettingsMock.mockReset();
    readSettingsMock.mockResolvedValue({});
    clearCredentialsMock.mockReset();
    clearMachineIdMock.mockReset();
    stopDaemonMock.mockReset();
    isDaemonStopIncompleteErrorMock.mockClear();
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

  it('passes a positive --wait-timeout to the auth polling owner', async () => {
    delete process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS;
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--wait-timeout', '300']);
      expect(process.env.HAPPIER_AUTH_WAIT_TIMEOUT_MS).toBe('300000');
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('recognizes a valid token-only credential as authenticated', async () => {
    readStoredCredentialsMock.mockResolvedValue({
      token: 'plain-token',
      encryption: null,
    });
    readSettingsMock.mockResolvedValue({ machineId: 'plain-machine' });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);

      expect(validateStoredAuthTokenAgainstActiveServerMock).toHaveBeenCalledWith('plain-token');
      expect(authAndSetupMachineIfNeededMock).not.toHaveBeenCalled();
      expect(consoleSpy.mock.calls.flat().join('\n')).toContain('Already authenticated');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('repairs rejected stored credentials instead of reporting already authenticated', async () => {
    readStoredCredentialsMock.mockResolvedValue({
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

  it('does not clear credentials, machine identity, or re-authenticate when invalid-token repair cannot stop the daemon', async () => {
    readStoredCredentialsMock.mockResolvedValue({
      token: 'stale-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({
      state: 'invalid',
      httpStatus: 401,
      reasonCode: 'not_authenticated',
    });
    const incomplete = Object.assign(new Error('daemon stop incomplete'), {
      code: 'daemon_stop_incomplete',
      reason: 'process_identity_unverified',
      pid: 12345,
    });
    stopDaemonMock.mockRejectedValueOnce(incomplete);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { handleAuthLogin } = await import('./login');

      await expect(handleAuthLogin([])).rejects.toBe(incomplete);

      expect(clearCredentialsMock).not.toHaveBeenCalled();
      expect(clearMachineIdMock).not.toHaveBeenCalled();
      expect(authAndSetupMachineIfNeededMock).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('does not clear credentials, machine identity, or re-authenticate when force login cannot stop the daemon', async () => {
    readStoredCredentialsMock.mockResolvedValue({
      token: createJwtWithSubject('account-force'),
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    const incomplete = Object.assign(new Error('daemon stop incomplete'), {
      code: 'daemon_stop_incomplete',
      reason: 'force_kill_unconfirmed',
      pid: 54321,
    });
    stopDaemonMock.mockRejectedValueOnce(incomplete);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { handleAuthLogin } = await import('./login');

      await expect(handleAuthLogin(['--force'])).rejects.toBe(incomplete);

      expect(clearCredentialsMock).not.toHaveBeenCalled();
      expect(clearMachineIdMock).not.toHaveBeenCalled();
      expect(authAndSetupMachineIfNeededMock).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('preserves force-auth replacement candidate using existing credential subject when settings are legacy', async () => {
    readStoredCredentialsMock.mockResolvedValue({
      token: createJwtWithSubject('account-legacy'),
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    readSettingsMock.mockResolvedValue({
      machineIdByServerId: { cloud: 'machine-legacy' },
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--force']);

      expect(clearCredentialsMock).toHaveBeenCalledTimes(1);
      expect(clearMachineIdMock).toHaveBeenCalledWith(expect.objectContaining({
        preserveReplacementCandidate: true,
        replacementReason: 'reauth',
        replacementAccountId: 'account-legacy',
      }));
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
