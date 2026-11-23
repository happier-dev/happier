import { type MachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings, StoredCredentials } from '@/persistence';
import type { ActiveServerStoredTokenValidationResult } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import { createEnvKeyScope } from '@/testkit/env/envScope';

const authAndSetupMachineIfNeededMock = vi.hoisted(() => vi.fn(async (_opts?: unknown) => ({
  machineId: 'm1',
  credentials: { token: 't1', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } },
})));
const validateStoredAuthTokenAgainstActiveServerMock = vi.hoisted(() =>
  vi.fn<(token: string) => Promise<ActiveServerStoredTokenValidationResult>>(async () => ({ state: 'valid', httpStatus: 200 })),
);
const readStoredCredentialsMock = vi.hoisted(() => vi.fn<() => Promise<StoredCredentials | null>>(async () => null));
const readMachineRegistrationMock = vi.hoisted(() => vi.fn<() => Promise<MachineRegistration>>(async () => ({})));
const clearCredentialsMock = vi.hoisted(() => vi.fn(async () => {}));
const clearMachineIdMock = vi.hoisted(() => vi.fn<(opts?: unknown) => Promise<void>>(async () => {}));
const stopDaemonMock = vi.hoisted(() => vi.fn(async () => ({ status: 'not_running' as const })));
const isDaemonStopIncompleteErrorMock = vi.hoisted(() => vi.fn((error: unknown) => (
  typeof error === 'object'
  && error !== null
  && (error as { code?: unknown }).code === 'daemon_stop_incomplete'
)));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: (opts?: unknown) => authAndSetupMachineIfNeededMock(opts),
}));

vi.mock('@/auth/validateStoredAuthTokenAgainstActiveServer', () => ({
  validateStoredAuthTokenAgainstActiveServer: (token: string) => validateStoredAuthTokenAgainstActiveServerMock(token),
}));

vi.mock('@/server/serverSelection', () => ({
  applyServerSelectionFromArgs: async (args: string[]) => args,
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: () => readStoredCredentialsMock(),
  clearCredentials: () => clearCredentialsMock(),
}));
vi.mock('@/daemon/machineIdentity/machineRegistrationStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/daemon/machineIdentity/machineRegistrationStore')>(),
  readMachineRegistration: () => readMachineRegistrationMock(),
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

describe('happier auth login', () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_AUTH_METHOD',
    'HAPPIER_AUTH_PRINT_CONFIGURE_LINKS',
    'HAPPIER_AUTH_WAIT_TIMEOUT_MS',
  ]);

  beforeEach(() => {
    // This test relies on per-file module mocks; ensure we never reuse a cached login module
    // from a prior test file executed in the same forked worker.
    vi.resetModules();
  });

  afterEach(() => {
    envScope.restore();
    authAndSetupMachineIfNeededMock.mockReset();
    authAndSetupMachineIfNeededMock.mockResolvedValue({
      machineId: 'm1',
      credentials: { token: 't1', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
    });
    validateStoredAuthTokenAgainstActiveServerMock.mockReset();
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({ state: 'valid', httpStatus: 200 });
    readStoredCredentialsMock.mockReset();
    readStoredCredentialsMock.mockResolvedValue(null);
    readMachineRegistrationMock.mockReset();
    readMachineRegistrationMock.mockResolvedValue({});
    clearCredentialsMock.mockReset();
    clearMachineIdMock.mockReset();
    stopDaemonMock.mockReset();
    stopDaemonMock.mockResolvedValue({ status: 'not_running' });
    isDaemonStopIncompleteErrorMock.mockClear();
    vi.resetModules();
  });

  it('sets HAPPIER_AUTH_METHOD before running the auth flow', async () => {
    delete process.env.HAPPIER_AUTH_METHOD;
    readStoredCredentialsMock.mockResolvedValue({
      token: 'valid-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    readMachineRegistrationMock.mockResolvedValue({ machineId: 'machine-1', confirmedByServer: true });
    let authMethodAtFlowStart: string | undefined;
    validateStoredAuthTokenAgainstActiveServerMock.mockImplementationOnce(async () => {
      authMethodAtFlowStart = process.env.HAPPIER_AUTH_METHOD;
      return { state: 'valid', httpStatus: 200 };
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--method', 'web']);

      expect(authMethodAtFlowStart).toBe('web');
      expect(process.env.HAPPIER_AUTH_METHOD).toBe('web');
      expect(authAndSetupMachineIfNeededMock).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('prints a friendly error and exits before auth when --method is invalid', async () => {
    delete process.env.HAPPIER_AUTH_METHOD;

    class ExitError extends Error {
      readonly code: number;

      constructor(code: number) {
        super(`process.exit(${code})`);
        this.code = code;
      }
    }

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new ExitError(typeof code === 'number' ? code : 0);
    }) as typeof process.exit);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { handleAuthLogin } = await import('./login');
      let thrown: unknown = null;
      try {
        await handleAuthLogin(['--method', 'nope']);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ExitError);
      expect((thrown as ExitError).code).toBe(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy.mock.calls[0]?.[0]).toMatch(/Invalid --method/i);
      expect(authAndSetupMachineIfNeededMock).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
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

  it('passes setup-managed caller intent when setup owns daemon reconciliation', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--no-daemon-start']);
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledWith({ callerIntent: 'setup-managed' });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('threads command cancellation into the authentication owner', async () => {
    const controller = new AbortController();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--no-daemon-start'], controller.signal);
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledWith({
        callerIntent: 'setup-managed',
        signal: controller.signal,
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('forwards Account material recovery without replacing the existing Home session', async () => {
    readStoredCredentialsMock.mockResolvedValue({ token: 'committed-home-token', encryption: null });
    readMachineRegistrationMock.mockResolvedValue({
      machineId: 'committed-home-machine',
      confirmedByServer: true,
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin(['--recover-account-material', '--no-daemon-start']);

      expect(clearCredentialsMock).not.toHaveBeenCalled();
      expect(clearMachineIdMock).not.toHaveBeenCalled();
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledWith({
        callerIntent: 'setup-managed',
        requireAccountMaterial: true,
      });
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('maps setup-managed authentication cancellation to a nonzero child outcome', async () => {
    authAndSetupMachineIfNeededMock.mockRejectedValueOnce(Object.assign(
      new Error('Authentication cancelled'),
      { code: 'authentication_cancelled' },
    ));
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${String(code ?? '')}`);
    }) as typeof process.exit);
    try {
      const { handleAuthLogin } = await import('./login');
      await expect(handleAuthLogin(['--no-daemon-start'])).rejects.toThrow('process.exit:1');
      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledWith({ callerIntent: 'setup-managed' });
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      consoleErrorSpy.mockRestore();
      consoleLogSpy.mockRestore();
    }
  });

  it('recognizes a valid token-only credential as authenticated', async () => {
    readStoredCredentialsMock.mockResolvedValue({
      token: 'plain-token',
      encryption: null,
    });
    readMachineRegistrationMock.mockResolvedValue({
      machineId: 'plain-machine',
      confirmedByServer: true,
    });
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

  it('does not report unknown server validation as already authenticated', async () => {
    readStoredCredentialsMock.mockResolvedValue({
      token: 'offline-token',
      encryption: null,
    });
    readMachineRegistrationMock.mockResolvedValue({
      machineId: 'confirmed-machine',
      confirmedByServer: true,
    });
    validateStoredAuthTokenAgainstActiveServerMock.mockResolvedValue({
      state: 'unknown',
      httpStatus: null,
      reasonCode: 'TimeoutError',
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const { handleAuthLogin } = await import('./login');
      await handleAuthLogin([]);

      expect(authAndSetupMachineIfNeededMock).toHaveBeenCalledOnce();
      expect(clearCredentialsMock).not.toHaveBeenCalled();
      expect(clearMachineIdMock).not.toHaveBeenCalled();
      expect(consoleSpy.mock.calls.flat().join('\n')).not.toContain('Already authenticated');
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('repairs rejected stored credentials instead of reporting already authenticated', async () => {
    readStoredCredentialsMock.mockResolvedValue({
      token: 'stale-token',
      encryption: { type: 'legacy', secret: new Uint8Array(32) },
    });
    readMachineRegistrationMock.mockResolvedValue({ machineId: 'machine-1' });
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
    readMachineRegistrationMock.mockResolvedValue({ machineId: 'machine-1' });
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
    readMachineRegistrationMock.mockResolvedValue({
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
