import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as processBoundary from '@happier-dev/cli-common/process';
import { GH_DEP_ID } from '@happier-dev/protocol/installables';

import { getGhDepStatus, ghBinPath, resolveGhNativeToken } from './gh';

describe('getGhDepStatus', () => {
  it('checks authentication against the requested GitHub host', async () => {
    const runGhCommand = vi.fn(async ({ args }: { args: readonly string[] }) => ({
      ok: args[0] === '--version' || args[3] === 'github.example.com',
      stdout: args[0] === '--version' ? 'gh version 2.75.0' : 'local-token-fixture',
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
    expect(runGhCommand.mock.calls.filter(([command]) => command.args[1] === 'status')).toHaveLength(0);
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
      args: ['auth', 'token', '--hostname', 'github.com'],
    }));
    expect(runGhCommand.mock.calls.filter(([command]) => command.args[1] === 'status')).toHaveLength(0);
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
    { systemToken: 'available', expectedPath: '/usr/local/bin/gh' },
    { systemToken: 'missing', expectedPath: '/managed/gh/current/bin/gh' },
    { systemToken: 'empty', expectedPath: '/managed/gh/current/bin/gh' },
  ])('retrieves an ephemeral host token with system token $systemToken ($expectedPath)', async ({ systemToken, expectedPath }) => {
    const runGhCommand = vi.fn(async ({ binPath, args }: { binPath: string; args: readonly string[] }) => {
      const managed = binPath.includes('/managed/');
      const ok = managed || systemToken !== 'missing';
      return {
        ok, stdout: ok && (managed || systemToken === 'available') && args[1] === 'token' ? '  ephemeral-token\n' : '',
        stderr: 'private diagnostic', exitCode: ok ? 0 : 1,
      };
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
      expect(command.args).toEqual(['auth', 'token', '--hostname', 'github.example.com']);
      expect(command).not.toHaveProperty('timeoutMs');
    }
  });

  it.each(['system', 'managed'] as const)('82 acquisitions use 82 local token reads and zero network status probes (%s)', async (source) => {
    const binPath = source === 'system' ? '/usr/local/bin/gh' : '/managed/gh/current/bin/gh';
    const runGhCommand = vi.fn(async (_command: { binPath: string; args: readonly string[] }) => ({ ok: true, stdout: 'ephemeral-token\n', stderr: '', exitCode: 0 }));
    for (let acquisition = 0; acquisition < 82; acquisition++) {
      const result = await resolveGhNativeToken({}, {
        resolveSystemGhBinPath: async () => source === 'system' ? binPath : null,
        resolveManagedGhBinPath: async () => '/managed/gh/current/bin/gh',
        runGhCommand,
      });
      expect(result).toEqual({ ok: true, token: 'ephemeral-token' });
    }
    expect(runGhCommand.mock.calls.filter(([command]) => command.args[1] === 'status')).toHaveLength(0);
    expect(runGhCommand.mock.calls.filter(([command]) => command.args[1] === 'token')).toHaveLength(82);
    // This is the subprocess-cost contract, measured at the OS command adapter.
    expect(runGhCommand).toHaveBeenCalledWith(expect.objectContaining({
      binPath, args: ['auth', 'token', '--hostname', 'github.com'],
    }));
    expect(runGhCommand.mock.calls).toHaveLength(82);
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

  it.each([
    { platform: 'linux', source: 'system' }, { platform: 'linux', source: 'managed' },
    { platform: 'darwin', source: 'system' }, { platform: 'darwin', source: 'managed' },
    { platform: 'win32', source: 'system' }, { platform: 'win32', source: 'managed' },
  ] as const)('keeps acquisition and repeated capability checks local with $source gh on $platform', async ({ platform, source }) => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!originalPlatform) throw new Error('Expected process.platform descriptor');
    const controller = new AbortController();
    const home = await mkdtemp(join(tmpdir(), 'gh-native-path-'));
    const systemDir = join(home, 'system');
    const env = { HAPPIER_HOME_DIR: home, PATH: systemDir, PATHEXT: '.EXE' };
    const systemBinPath = join(systemDir, platform === 'win32' ? 'gh.exe' : 'gh');
    let binPath = systemBinPath;
    let signedIn = true;
    // The subprocess is the OS boundary; selection and command construction remain real.
    const execute = vi.spyOn(processBoundary, 'execFileWithDeadline').mockImplementation(async (command, args, options) => {
      expect([systemBinPath, ghBinPath(env)]).toContain(command);
      expect(options.signal).toBe(controller.signal);
      expect(options.windowsHide).toBe(true);
      if (args[0] === '--version') return { stdout: 'gh version 2.75.0\n', stderr: '' };
      expect(args.slice(-2)).toEqual(['--hostname', 'github.example.com']);
      if (!signedIn) throw Object.assign(new Error('not logged in'), { code: 1 });
      return { stdout: args[1] === 'token' ? 'ephemeral-token\n' : '', stderr: '' };
    });
    try {
      Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
      const managedBinPath = ghBinPath(env);
      await mkdir(dirname(managedBinPath), { recursive: true });
      await writeFile(managedBinPath, 'fixture');
      if (platform !== 'win32') await chmod(managedBinPath, 0o755);
      if (source === 'system') {
        await mkdir(systemDir);
        await writeFile(systemBinPath, 'fixture');
        if (platform !== 'win32') await chmod(systemBinPath, 0o755);
      } else {
        binPath = managedBinPath;
      }
      await expect(resolveGhNativeToken({ hostname: 'github.example.com', signal: controller.signal, env }))
        .resolves.toEqual({ ok: true, token: 'ephemeral-token' });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[2]).not.toHaveProperty('timeout');
      expect(execute.mock.calls[0]?.[1]).toEqual(['auth', 'token', '--hostname', 'github.example.com']);
      execute.mockClear();
      for (let check = 0; check < 82; check++) {
        await expect(getGhDepStatus({ hostname: 'github.example.com', signal: controller.signal, env }))
          .resolves.toEqual(expect.objectContaining({ installed: true, authenticated: true, binPath }));
      }
      expect(execute.mock.calls.filter(([, args]) => args[1] === 'status')).toHaveLength(0);
      expect(execute.mock.calls.filter(([, args]) => args[1] === 'token')).toHaveLength(82);

      signedIn = false;
      await expect(getGhDepStatus({ hostname: 'github.example.com', signal: controller.signal, env }))
        .resolves.toEqual(expect.objectContaining({ installed: true, authenticated: false, authStatus: 'missing_auth', remediationReason: 'auth_required' }));
      await rm(managedBinPath);
      if (source === 'system') await rm(systemBinPath);
      execute.mockClear();
      await expect(getGhDepStatus({ hostname: 'github.example.com', signal: controller.signal, env }))
        .resolves.toEqual(expect.objectContaining({ installed: false, authenticated: null, remediationReason: 'install_required' }));
      expect(execute).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
      await rm(home, { recursive: true, force: true });
    }
  });

  it('sanitizes rejected token commands and preserves cancellation at the process boundary', async () => {
    const controller = new AbortController();
    const cancellation = new Error('caller cancelled');
    const commandFailure = Object.assign(new Error('private token diagnostic'), { stdout: 'private-token', stderr: 'private-token' });
    const execute = vi.spyOn(processBoundary, 'execFileWithDeadline').mockImplementation(async () => {
      throw commandFailure;
    });
    const deps = {
      resolveSystemGhBinPath: async () => '/tools/gh',
      resolveManagedGhBinPath: async () => null,
    };
    await expect(resolveGhNativeToken({}, deps)).resolves.toEqual({
      ok: false, reason: 'unavailable', remediation: 'sign in with gh CLI',
    });
    execute.mockImplementation(async () => {
      controller.abort(cancellation);
      throw commandFailure;
    });
    await expect(resolveGhNativeToken({ signal: controller.signal }, deps)).rejects.toBe(cancellation);
  });
});
