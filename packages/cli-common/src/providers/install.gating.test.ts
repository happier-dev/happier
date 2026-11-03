import { describe, expect, it, vi } from 'vitest';
import { spawnSync as spawnLocalCommand } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { runCommandCapture } from '../process/index.js';
import { installProviderCli, resolvePlatformFromNodePlatform } from './install.js';

type SpawnSyncShapedMock = (
  command: string,
  args?: ReadonlyArray<string>,
  options?: import('node:child_process').SpawnSyncOptions,
) => import('node:child_process').SpawnSyncReturns<Buffer | string>;

/**
 * Long-running install commands run through the async process owner (`runCommand`);
 * these tests describe the child process with one spawnSync-shaped fake, so adapt it.
 */
function runCommandFrom(mock: SpawnSyncShapedMock): typeof runCommandCapture {
  return async ({ cmd, args, cwd, env }) => {
    const result = mock(cmd, args, { cwd, env });
    if (result.error) return { kind: 'spawn-failed', message: result.error.message, error: result.error };
    return {
      kind: 'exited',
      status: result.status,
      signal: result.signal,
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  };
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

describe('installProviderCli vendor_recipe execution gating', () => {
  it.skipIf(process.platform === 'win32')('preserves a Windows Path-only environment when executing a vendor recipe', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-vendor-windows-path-'));
    if (!originalPlatformDescriptor) throw new Error('Expected configurable platform');
    const previousPath = process.env.PATH;
    try {
      // A real harmless executable stands in for the vendor's OS process. The
      // install owner, PATH resolution and child-process capture remain real.
      const executable = join(homeDir, 'powershell.exe');
      await writeFile(executable, '#!/bin/sh\nprintf vendor-process-started\n', 'utf8');
      await chmod(executable, 0o755);
      delete process.env.PATH;
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
      const result = await installProviderCli({
        providerId: 'droid', platform: 'win32',
        env: { Path: homeDir, HAPPIER_HOME_DIR: homeDir },
        logDir: homeDir, skipIfInstalled: false, allowVendorRecipeExecution: true,
      });
      expect(result.ok, result.ok ? undefined : result.errorMessage).toBe(true);
      if (result.logPath) expect(await readFile(result.logPath, 'utf8')).toContain('vendor-process-started');
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('denies vendor_recipe execution by default (but still returns the plan)', async () => {
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-gating-log-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      const res = await installProviderCli({
        providerId: 'claude',
        platform,
        logDir,
        // Avoid accidentally running real commands in the pre-gating implementation.
        env: { ...process.env, PATH: '' },
        skipIfInstalled: false,
      });

      expect(res.ok).toBe(false);
      if (res.ok) return;

      expect(res.errorCode).toBe('vendor-recipe-disallowed');
      expect(res.plan?.installMode).toBe('vendor_recipe');
      expect(res.logPath).toBeNull();
      expect(res.errorMessage).toContain('allowVendorRecipeExecution');
    } finally {
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('uses the injected process boundary for managed_package installs', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-gating-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-gating-log-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      type SpawnSyncMockFn = (
        command: string,
        args?: ReadonlyArray<string>,
        options?: import('node:child_process').SpawnSyncOptions,
      ) => import('node:child_process').SpawnSyncReturns<Buffer>;
      const spawnSyncMock = vi
        .fn<SpawnSyncMockFn>(() => ({
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.alloc(0)],
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }))
        .mockName('spawnSync');

      const res = await installProviderCli({
        providerId: 'gemini',
        platform,
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: '',
        },
        skipIfInstalled: false,
        deps: {
          ensureManagedPnpmCommand: async () => 'pnpm-does-not-exist',
          ensureManagedJavaScriptRuntimeCommand: async () => '/nonexistent/node',
          runCommand: runCommandFrom(spawnSyncMock),
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.plan.installMode).toBe('managed_package');
      expect(spawnSyncMock).toHaveBeenCalled();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it.each(['linux', 'darwin', 'win32'] as const)('installs OpenCode 2 with only its vendor build approved on %s', async (platform) => {
    if (!originalPlatformDescriptor) throw new Error('Expected configurable platform');
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-install-opencode-'));
    Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: platform });
    try {
      // The package manager is the external boundary. Model its published package's
      // postinstall requirement; installation, promotion and launch stay real.
      const runCommand = vi.fn<typeof runCommandCapture>(async ({ args, cwd }) => {
        if (!args?.includes('@opencode/cli') || !args.includes('--allow-build=@opencode/cli')
          || !args.includes('--ignore-scripts=false')) {
          return { kind: 'exited', status: 1, signal: null, stdout: '', stderr: 'OpenCode 2 postinstall was not approved' };
        }
        if (!cwd) throw new Error('Expected managed package workspace');
        const binDir = join(cwd, 'node_modules', '.bin');
        mkdirSync(binDir, { recursive: true });
        const binary = join(binDir, platform === 'win32' ? 'opencode.cmd' : 'opencode');
        writeFileSync(binary, '#!/bin/sh\necho 2.2.5\n', { mode: 0o755 });
        return { kind: 'exited', status: 0, signal: null, stdout: '', stderr: '' };
      });
      const deps = {
        ensureManagedPnpmCommand: async () => '/managed/pnpm',
        ensureManagedJavaScriptRuntimeCommand: async () => '/managed/node/bin/node',
        runCommand,
      };
      const input = {
        providerId: 'opencode' as const, platform, skipIfInstalled: false,
        env: { ...process.env, HAPPIER_HOME_DIR: homeDir, PATH: '' }, logDir: homeDir, deps,
      };
      const result = await installProviderCli(input);
      expect(result.ok, result.ok ? undefined : result.errorMessage).toBe(true);
      if (!result.ok) return;
      expect(result.plan.managedInstall).toEqual({
        kind: 'managed_package', packageName: '@opencode/cli', binaryName: 'opencode', allowBuild: true,
      });
      const command = runCommand.mock.calls[0]?.[0];
      expect(command?.cmd).toBe('/managed/pnpm');
      expect(command?.env?.PATH).toContain('/managed/node/bin');
      const launcherPath = join(homeDir, 'tools', 'providers', 'opencode', 'current', 'bin', platform === 'win32' ? 'opencode.cmd' : 'opencode');
      const launcher = await readFile(launcherPath, 'utf8');
      expect(launcher).toContain('node_modules');
      if (platform !== 'win32' && originalPlatformDescriptor.value !== 'win32') {
        const launched = spawnLocalCommand(launcherPath, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
        expect(launched.status).toBe(0);
        expect(launched.stdout.trim()).toBe('2.2.5');
      }

      // A failed vendor build must be visible and leave the installed release intact.
      runCommand.mockResolvedValueOnce({ kind: 'exited', status: 1, signal: null, stdout: '', stderr: 'vendor build failed' });
      const failed = await installProviderCli(input);
      expect(failed).toMatchObject({ ok: false, errorCode: 'command-failed', errorMessage: 'vendor build failed' });
      expect(await readFile(launcherPath, 'utf8')).toBe(launcher);
      expect(await readFile(failed.logPath!, 'utf8')).toContain('vendor build failed');
    } finally {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('writes install logs with private file permissions', async () => {
    if (process.platform === 'win32') return;
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-log-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-log-dir-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      type SpawnSyncMockFn = (
        command: string,
        args?: ReadonlyArray<string>,
        options?: import('node:child_process').SpawnSyncOptions,
      ) => import('node:child_process').SpawnSyncReturns<Buffer>;
      const spawnSyncMock = vi
        .fn<SpawnSyncMockFn>(() => ({
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.alloc(0)],
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }))
        .mockName('spawnSync');

      const res = await installProviderCli({
        providerId: 'gemini',
        platform,
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: '',
        },
        skipIfInstalled: false,
        deps: {
          ensureManagedPnpmCommand: async () => 'pnpm-does-not-exist',
          ensureManagedJavaScriptRuntimeCommand: async () => '/nonexistent/node',
          runCommand: runCommandFrom(spawnSyncMock),
        },
      });

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.logPath).not.toBeNull();
      if (!res.logPath) return;

      const fileStat = await stat(res.logPath);
      expect(fileStat.mode & 0o777).toBe(0o600);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('prepends the managed JavaScript runtime path when installing managed packages', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-runtime-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-runtime-log-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      type SpawnSyncMockFn = (
        command: string,
        args?: ReadonlyArray<string>,
        options?: import('node:child_process').SpawnSyncOptions,
      ) => import('node:child_process').SpawnSyncReturns<Buffer>;
      const spawnSyncMock = vi
        .fn<SpawnSyncMockFn>(() => ({
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.alloc(0)],
          status: 0,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }))
        .mockName('spawnSync');

      const runtimeCommand =
        process.platform === 'win32' ? 'C:\\managed\\node\\node.exe' : '/managed/node/bin/node';

      const res = await installProviderCli({
        providerId: 'gemini',
        platform,
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          PATH: '',
        },
        skipIfInstalled: false,
        deps: {
          ensureManagedPnpmCommand: async () => 'pnpm-does-not-exist',
          ensureManagedJavaScriptRuntimeCommand: async () => runtimeCommand,
          runCommand: runCommandFrom(spawnSyncMock),
        },
      });

      expect(res.ok).toBe(true);
      const firstCall = spawnSyncMock.mock.calls[0];
      expect(firstCall).toBeDefined();
      const spawnEnv = firstCall?.[2]?.env;
      expect(typeof spawnEnv?.PATH).toBe('string');
      expect(String(spawnEnv?.PATH)).toContain(process.platform === 'win32' ? 'C:\\managed\\node' : '/managed/node/bin');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
    }
  });

  it('surfaces a targeted memory-pressure hint when a vendor recipe is killed with exit 137', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-vendor-oom-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-vendor-oom-log-'));
    const binDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-vendor-oom-bin-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      type SpawnSyncMockFn = (
        command: string,
        args?: ReadonlyArray<string>,
        options?: import('node:child_process').SpawnSyncOptions,
      ) => import('node:child_process').SpawnSyncReturns<Buffer>;
      const spawnSyncMock = vi
        .fn<SpawnSyncMockFn>(() => ({
          pid: 0,
          output: [null, Buffer.alloc(0), Buffer.from('installer died')],
          status: 137,
          signal: 'SIGKILL',
          stdout: Buffer.alloc(0),
          stderr: Buffer.from('installer died'),
        }))
        .mockName('spawnSync');

      const bashPath = join(binDir, process.platform === 'win32' ? 'bash.cmd' : 'bash');
      await writeFile(bashPath, process.platform === 'win32' ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', 'utf8');
      if (process.platform !== 'win32') {
        await chmod(bashPath, 0o755);
      }

      const res = await installProviderCli({
        providerId: 'claude',
        platform,
        logDir,
        env: {
          ...process.env,
          HAPPIER_HOME_DIR: homeDir,
          HOME: homeDir,
          PATH: `${binDir}:/bin`,
        },
        skipIfInstalled: false,
        allowVendorRecipeExecution: true,
        deps: {
          runCommand: runCommandFrom(spawnSyncMock),
        },
      });

      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.errorCode).toBe('command-failed');
      expect(res.errorMessage).toContain('ran out of memory');
      expect(res.errorMessage).toContain('increase available memory or swap');
      expect(res.logPath).not.toBeNull();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
      await rm(logDir, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
