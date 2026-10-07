import { afterEach, describe, expect, it, vi } from 'vitest';

import * as processBoundary from '@happier-dev/cli-common/process';
import { GH_DEP_ID } from '@happier-dev/protocol/installables';

import { getGhDepStatus, resolveGhNativeToken } from './gh';

describe('getGhDepStatus', () => {
  it('checks authentication against the requested GitHub host', async () => {
    const runGhCommand = vi.fn(async ({ args }: { args: readonly string[] }) => ({
      ok: args[0] === '--version' || args[3] === 'github.example.com',
      stdout: args[0] === '--version' ? 'gh version 2.75.0' : '',
      stderr: '',
      exitCode: args[0] === '--version' || args[3] === 'github.example.com' ? 0 : 1,
    }));
    const result = await getGhDepStatus({ hostname: 'github.example.com' }, {
      resolveSystemGhBinPath: async () => '/usr/local/bin/gh',
      resolveManagedGhBinPath: async () => null,
      runGhCommand,
      readState: async () => ({ installedVersion: null, lastInstallLogPath: null }),
      readLastBackgroundUpdateCheckAtMs: async () => null,
    });
    expect(result.authenticated).toBe(true);
  });

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

describe('resolveGhNativeToken', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { systemAuthenticated: true, expectedPath: '/usr/local/bin/gh' },
    { systemAuthenticated: false, expectedPath: '/managed/gh/current/bin/gh' },
  ])('retrieves an ephemeral host token from the authenticated owner ($expectedPath)', async ({ systemAuthenticated, expectedPath }) => {
    const runGhCommand = vi.fn(async ({ binPath, args }: { binPath: string; args: readonly string[] }) => {
      if (args[1] === 'token') {
        return { ok: true, stdout: '  ephemeral-token\n', stderr: 'private diagnostic', exitCode: 0 };
      }
      const ok = binPath.includes('/managed/') || systemAuthenticated;
      return { ok, stdout: '', stderr: 'private auth diagnostic', exitCode: ok ? 0 : 1 };
    });
    const result = await resolveGhNativeToken({ hostname: 'github.example.com' }, {
      resolveSystemGhBinPath: async () => '/usr/local/bin/gh',
      resolveManagedGhBinPath: async () => '/managed/gh/current/bin/gh',
      runGhCommand,
    });
    expect(result).toEqual({ ok: true, token: 'ephemeral-token' });
    expect(runGhCommand).toHaveBeenCalledWith(expect.objectContaining({
      binPath: expectedPath,
      args: ['auth', 'token', '--hostname', 'github.example.com'],
    }));
    for (const [command] of runGhCommand.mock.calls) {
      expect(command.args).toEqual(['auth', expect.stringMatching(/^(status|token)$/), '--hostname', 'github.example.com']);
      expect(command).not.toHaveProperty('timeoutMs');
    }
  });

  it.each(['missing', 'logged_out', 'token_failed', 'empty_token'] as const)('returns only remediation when gh is %s', async (failure) => {
    const result = await resolveGhNativeToken({}, {
      resolveSystemGhBinPath: async () => failure === 'missing' ? null : '/usr/local/bin/gh',
      resolveManagedGhBinPath: async () => null,
      runGhCommand: async ({ args }) => ({
        ok: failure !== 'logged_out' && !(failure === 'token_failed' && args[1] === 'token'),
        stdout: failure === 'empty_token' ? ' \n' : 'private-token',
        stderr: 'private-diagnostic',
        exitCode: failure === 'logged_out' || failure === 'token_failed' ? 1 : 0,
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'unavailable', remediation: 'sign in with gh CLI' });
  });

  it('keeps caller cancellation distinct from authentication remediation', async () => {
    const controller = new AbortController();
    const cancellation = new Error('caller cancelled');
    const runGhCommand = vi.fn(async ({ signal }: { signal?: AbortSignal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort(cancellation);
      return { ok: false, stdout: 'private-token', stderr: '', exitCode: null };
    });
    await expect(resolveGhNativeToken({ signal: controller.signal }, {
      resolveSystemGhBinPath: async () => '/usr/local/bin/gh',
      resolveManagedGhBinPath: async () => null,
      runGhCommand,
    })).rejects.toBe(cancellation);
  });

  it.each(['linux', 'darwin', 'win32'] as const)('runs native token retrieval through the cancellable process boundary on %s', async (platform) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!originalPlatform) throw new Error('Expected process.platform descriptor');
    const controller = new AbortController();
    const binPath = platform === 'win32' ? 'C:\\tools\\gh.exe' : '/tools/gh';
    // The subprocess is the OS boundary; selection and command construction remain real.
    const execute = vi.spyOn(processBoundary, 'execFileWithDeadline').mockImplementation(async (command, args, options) => {
      expect(command).toBe(binPath);
      expect(options.signal).toBe(controller.signal);
      expect(options).not.toHaveProperty('timeout');
      expect(options.windowsHide).toBe(true);
      expect(args.slice(-2)).toEqual(['--hostname', 'github.example.com']);
      return { stdout: args[1] === 'token' ? 'ephemeral-token\n' : '', stderr: '' };
    });
    try {
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
      await expect(resolveGhNativeToken({ hostname: 'github.example.com', signal: controller.signal }, {
        resolveSystemGhBinPath: async () => binPath,
        resolveManagedGhBinPath: async () => null,
      })).resolves.toEqual({ ok: true, token: 'ephemeral-token' });
      expect(execute).toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
  });

  it('sanitizes rejected token commands and preserves cancellation at the process boundary', async () => {
    const controller = new AbortController();
    const cancellation = new Error('caller cancelled');
    const commandFailure = Object.assign(new Error('private token diagnostic'), { stdout: 'private-token', stderr: 'private-token' });
    const execute = vi.spyOn(processBoundary, 'execFileWithDeadline').mockImplementation(async (_command, args) => {
      if (args[1] === 'status') return { stdout: '', stderr: '' };
      throw commandFailure;
    });
    const deps = {
      resolveSystemGhBinPath: async () => '/tools/gh',
      resolveManagedGhBinPath: async () => null,
    };
    await expect(resolveGhNativeToken({}, deps)).resolves.toEqual({
      ok: false, reason: 'unavailable', remediation: 'sign in with gh CLI',
    });
    execute.mockImplementation(async (_command, args) => {
      if (args[1] === 'status') return { stdout: '', stderr: '' };
      controller.abort(cancellation);
      throw commandFailure;
    });
    await expect(resolveGhNativeToken({ signal: controller.signal }, deps)).rejects.toBe(cancellation);
  });
});
