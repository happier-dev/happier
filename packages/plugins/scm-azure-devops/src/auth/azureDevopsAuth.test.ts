import { describe, expect, it, vi } from 'vitest';

const provider = {
  id: 'scm.azure-devops',
  kind: 'azure-devops',
  displayName: 'Azure DevOps',
  baseUrl: 'https://dev.azure.com/happier-dev',
  nameWithOwner: 'happier-dev/platform/happier',
} as const;

describe('Azure DevOps CLI auth diagnostics', () => {
  it('reports missing Azure CLI as install remediation without invoking az', async () => {
    const mod = await import('./azureDevopsAuth.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const runCommand = vi.fn();
    await expect(mod.detectAzureDevopsCliAuth({
      provider,
      runtimeServices: {
        resolveInstallableCommand: async () => ({ kind: 'missing' }),
        runCommand,
      },
    })).resolves.toEqual(expect.objectContaining({
      kind: 'missing-cli',
      capabilityId: 'dep.az',
      remediation: expect.objectContaining({
        kind: 'install_required',
      }),
    }));
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('reports unauthenticated Azure CLI as login remediation without running login', async () => {
    const mod = await import('./azureDevopsAuth.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    const runCommand = vi.fn(async () => ({
      ok: false,
      stdout: '',
      stderr: 'Please run az login to setup account.',
      exitCode: 1,
    }));

    await expect(mod.detectAzureDevopsCliAuth({
      provider,
      runtimeServices: {
        resolveInstallableCommand: async () => ({ kind: 'available', source: 'system', binPath: '/usr/local/bin/az' }),
        runCommand,
      },
    })).resolves.toEqual(expect.objectContaining({
      kind: 'missing-auth',
      capabilityId: 'dep.az',
      remediation: expect.objectContaining({
        kind: 'auth_required',
        commandPreview: ['az', 'login'],
      }),
    }));
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(expect.objectContaining({
      binPath: '/usr/local/bin/az',
      args: ['account', 'show', '--output', 'json'],
    }));
  });

  it('reports authenticated Azure CLI account metadata', async () => {
    const mod = await import('./azureDevopsAuth.js').catch(() => null);
    expect(mod).not.toBeNull();
    if (!mod) return;

    await expect(mod.detectAzureDevopsCliAuth({
      provider,
      runtimeServices: {
        resolveInstallableCommand: async () => ({ kind: 'available', source: 'system', binPath: '/usr/local/bin/az' }),
        runCommand: async () => ({
          ok: true,
          stdout: JSON.stringify({ user: { name: 'dev@example.com' }, tenantId: 'tenant-1' }),
          stderr: '',
          exitCode: 0,
        }),
      },
    })).resolves.toEqual(expect.objectContaining({
      kind: 'authenticated',
      capabilityId: 'dep.az',
      accountName: 'dev@example.com',
      tenantId: 'tenant-1',
    }));
  });
});
