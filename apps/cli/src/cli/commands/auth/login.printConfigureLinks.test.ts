import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authAndSetupMachineIfNeededMock = vi.fn(async () => ({
  machineId: 'm1',
  credentials: { token: 't1', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
}));

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: () => authAndSetupMachineIfNeededMock(),
}));

vi.mock('@/server/serverSelection', () => ({
  applyServerSelectionFromArgs: async (args: string[]) => args,
}));

vi.mock('@/persistence', () => ({
  readCredentials: async () => null,
  readSettings: async () => ({}),
  clearCredentials: async () => {},
  clearMachineId: async () => {},
}));

vi.mock('@/daemon/controlClient', () => ({
  stopDaemon: async () => {},
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
});
