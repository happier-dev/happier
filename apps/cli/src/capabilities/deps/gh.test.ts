import { describe, expect, it, vi } from 'vitest';

import { GH_DEP_ID } from '@happier-dev/protocol/installables';

import { getGhDepStatus } from './gh';

describe('getGhDepStatus', () => {
  it('prefers an authenticated system gh over managed gh', async () => {
    const runGhCommand = vi.fn(async ({ args }: { args: readonly string[] }) => {
      if (args[0] === '--version') {
        return { ok: true as const, stdout: 'gh version 2.75.0 (2026-05-01)\n', stderr: '', exitCode: 0 };
      }
      if (args[0] === 'auth') {
        return { ok: true as const, stdout: 'github.com\n  ✓ Logged in to github.com account octo\n', stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected args: ${args.join(' ')}`);
    });

    await expect(
      getGhDepStatus({}, {
        resolveSystemGhBinPath: async () => '/usr/local/bin/gh',
        resolveManagedGhBinPath: async () => '/managed/gh/current/bin/gh',
        runGhCommand,
        readState: async () => ({ installedVersion: '2.70.0', lastInstallLogPath: '/tmp/managed.log' }),
        readLastBackgroundUpdateCheckAtMs: async () => 123,
      }),
    ).resolves.toEqual(expect.objectContaining({
      installed: true,
      capabilityId: GH_DEP_ID,
      binPath: '/usr/local/bin/gh',
      resolvedSource: 'system',
      authenticated: true,
      authStatus: 'authenticated',
      remediationReason: null,
      installedVersion: '2.75.0',
      managedBinPath: '/managed/gh/current/bin/gh',
      lastBackgroundUpdateCheckAtMs: 123,
    }));

    expect(runGhCommand).toHaveBeenCalledWith(expect.objectContaining({
      binPath: '/usr/local/bin/gh',
      args: ['auth', 'status', '--hostname', 'github.com'],
    }));
  });

  it('distinguishes installed but unauthenticated system gh from missing gh', async () => {
    await expect(
      getGhDepStatus({}, {
        resolveSystemGhBinPath: async () => '/usr/local/bin/gh',
        resolveManagedGhBinPath: async () => null,
        runGhCommand: async ({ args }) => args[0] === '--version'
          ? { ok: true, stdout: 'gh version 2.74.2\n', stderr: '', exitCode: 0 }
          : { ok: false, stdout: '', stderr: 'not logged in', exitCode: 1 },
        readState: async () => ({ installedVersion: null, lastInstallLogPath: null }),
        readLastBackgroundUpdateCheckAtMs: async () => null,
      }),
    ).resolves.toEqual(expect.objectContaining({
      installed: true,
      binPath: '/usr/local/bin/gh',
      resolvedSource: 'system',
      authenticated: false,
      authStatus: 'missing_auth',
      remediationReason: 'auth_required',
    }));
  });

  it('falls back to managed gh when system gh is missing', async () => {
    await expect(
      getGhDepStatus({}, {
        resolveSystemGhBinPath: async () => null,
        resolveManagedGhBinPath: async () => '/managed/gh/current/bin/gh',
        runGhCommand: async ({ args }) => args[0] === '--version'
          ? { ok: true, stdout: 'gh version 2.73.0\n', stderr: '', exitCode: 0 }
          : { ok: true, stdout: 'logged in', stderr: '', exitCode: 0 },
        readState: async () => ({ installedVersion: '2.73.0', lastInstallLogPath: '/tmp/gh-install.log' }),
        readLastBackgroundUpdateCheckAtMs: async () => null,
      }),
    ).resolves.toEqual(expect.objectContaining({
      installed: true,
      binPath: '/managed/gh/current/bin/gh',
      managedBinPath: '/managed/gh/current/bin/gh',
      resolvedSource: 'managed',
      authenticated: true,
      authStatus: 'authenticated',
      installedVersion: '2.73.0',
      lastInstallLogPath: '/tmp/gh-install.log',
    }));
  });

  it('uses authenticated managed gh when system gh exists but is unauthenticated', async () => {
    await expect(
      getGhDepStatus({}, {
        resolveSystemGhBinPath: async () => '/usr/local/bin/gh',
        resolveManagedGhBinPath: async () => '/managed/gh/current/bin/gh',
        runGhCommand: async ({ binPath, args }) => {
          if (args[0] === '--version') {
            return {
              ok: true,
              stdout: binPath.includes('/managed/')
                ? 'gh version 2.73.0\n'
                : 'gh version 2.74.2\n',
              stderr: '',
              exitCode: 0,
            };
          }
          return binPath.includes('/managed/')
            ? { ok: true, stdout: 'logged in', stderr: '', exitCode: 0 }
            : { ok: false, stdout: '', stderr: 'not logged in', exitCode: 1 };
        },
        readState: async () => ({ installedVersion: '2.73.0', lastInstallLogPath: '/tmp/gh-install.log' }),
        readLastBackgroundUpdateCheckAtMs: async () => null,
      }),
    ).resolves.toEqual(expect.objectContaining({
      installed: true,
      binPath: '/managed/gh/current/bin/gh',
      managedBinPath: '/managed/gh/current/bin/gh',
      resolvedSource: 'managed',
      authenticated: true,
      authStatus: 'authenticated',
      installedVersion: '2.73.0',
    }));
  });

  it('does not report an installed gh as signed out when the auth probe never completed', async () => {
    await expect(
      getGhDepStatus({}, {
        resolveSystemGhBinPath: async () => '/usr/local/bin/gh',
        resolveManagedGhBinPath: async () => null,
        runGhCommand: async ({ args }) => (
          args[0] === '--version'
            ? { ok: true, stdout: 'gh version 2.75.0\n', stderr: '', exitCode: 0 }
            : { ok: false, stdout: '', stderr: '', exitCode: null }
        ),
        readState: async () => ({ installedVersion: null, lastInstallLogPath: null }),
        readLastBackgroundUpdateCheckAtMs: async () => null,
      }),
    ).resolves.toEqual(expect.objectContaining({
      installed: true,
      authenticated: null,
      authStatus: 'unknown',
      remediationReason: null,
    }));
  });

  it('reports a missing installable with explicit install remediation', async () => {
    await expect(
      getGhDepStatus({}, {
        resolveSystemGhBinPath: async () => null,
        resolveManagedGhBinPath: async () => null,
        runGhCommand: async () => ({ ok: false, stdout: '', stderr: '', exitCode: null }),
        readState: async () => ({ installedVersion: null, lastInstallLogPath: '/tmp/previous.log' }),
        readLastBackgroundUpdateCheckAtMs: async () => null,
      }),
    ).resolves.toEqual(expect.objectContaining({
      installed: false,
      binPath: null,
      managedBinPath: null,
      resolvedSource: null,
      authenticated: null,
      authStatus: 'unknown',
      remediationReason: 'install_required',
      lastInstallLogPath: '/tmp/previous.log',
    }));
  });

  it('reports unsupported managed platform as unsupported instead of installable', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      if (!originalPlatform) {
        throw new Error('Expected process.platform descriptor');
      }
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'freebsd' });

      await expect(
        getGhDepStatus({}, {
          resolveSystemGhBinPath: async () => null,
          resolveManagedGhBinPath: async () => null,
          runGhCommand: async () => ({ ok: false, stdout: '', stderr: '', exitCode: null }),
          readState: async () => ({ installedVersion: null, lastInstallLogPath: null }),
          readLastBackgroundUpdateCheckAtMs: async () => null,
        }),
      ).resolves.toEqual(expect.objectContaining({
        installed: false,
        remediationReason: 'unsupported',
      }));
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });
});
