import { describe, expect, it, vi } from 'vitest';

describe('getAzDepStatus', () => {
  it('reports authenticated system Azure CLI without managed fallback', async () => {
    const mod = await import('./az').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const runAzCommand = vi.fn(async ({ args }: { args: readonly string[] }) => {
      if (args[0] === '--version') {
        return { ok: true as const, stdout: 'azure-cli 2.72.0\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'account') {
        return {
          ok: true as const,
          stdout: JSON.stringify({ user: { name: 'dev@example.com' }, tenantId: 'tenant-1' }),
          stderr: '',
          exitCode: 0,
        };
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    await expect(
      mod.getAzDepStatus({}, {
        resolveSystemAzBinPath: async () => '/usr/local/bin/az',
        runAzCommand,
      }),
    ).resolves.toEqual(expect.objectContaining({
      installed: true,
      capabilityId: 'dep.az',
      binPath: '/usr/local/bin/az',
      managedBinPath: null,
      sourceKind: 'manual_only',
      resolvedSource: 'system',
      authenticated: true,
      authStatus: 'authenticated',
      remediationReason: null,
      installedVersion: '2.72.0',
      accountName: 'dev@example.com',
    }));

    expect(runAzCommand).toHaveBeenCalledWith(expect.objectContaining({
      binPath: '/usr/local/bin/az',
      args: ['account', 'show', '--output', 'json'],
    }));
  });

  it('distinguishes unauthenticated system Azure CLI from missing Azure CLI', async () => {
    const mod = await import('./az').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    await expect(
      mod.getAzDepStatus({}, {
        resolveSystemAzBinPath: async () => '/usr/local/bin/az',
        runAzCommand: async ({ args }: { args: readonly string[] }) => args[0] === '--version'
          ? { ok: true, stdout: 'azure-cli 2.71.0\n', stderr: '', exitCode: 0 }
          : { ok: false, stdout: '', stderr: 'Please run az login to setup account.', exitCode: 1 },
      }),
    ).resolves.toEqual(expect.objectContaining({
      installed: true,
      binPath: '/usr/local/bin/az',
      authenticated: false,
      authStatus: 'missing_auth',
      remediationReason: 'auth_required',
      loginCommand: ['az', 'login'],
    }));
  });

  it('does not report an installed Azure CLI as signed out when the probe never completed', async () => {
    const mod = await import('./az').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    await expect(
      mod.getAzDepStatus({}, {
        resolveSystemAzBinPath: async () => '/usr/local/bin/az',
        runAzCommand: async ({ args }) => (
          args[0] === '--version'
            ? { ok: true, stdout: 'azure-cli 2.72.0\n', stderr: '', exitCode: 0 }
            : { ok: false, stdout: '', stderr: '', exitCode: null }
        ),
      }),
    ).resolves.toEqual(expect.objectContaining({
      installed: true,
      authenticated: null,
      authStatus: 'unknown',
      remediationReason: null,
    }));
  });

  it('reports a missing system Azure CLI as manual install required', async () => {
    const mod = await import('./az').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    await expect(
      mod.getAzDepStatus({}, {
        resolveSystemAzBinPath: async () => null,
        runAzCommand: async () => ({ ok: false, stdout: '', stderr: '', exitCode: null }),
      }),
    ).resolves.toEqual(expect.objectContaining({
      installed: false,
      binPath: null,
      managedBinPath: null,
      resolvedSource: null,
      authenticated: null,
      authStatus: 'unknown',
      remediationReason: 'install_required',
      setupUrl: expect.stringMatching(/^https:\/\/learn\.microsoft\.com\//),
    }));
  });
});
