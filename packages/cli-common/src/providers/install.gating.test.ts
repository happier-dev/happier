import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { installProviderCli, resolvePlatformFromNodePlatform } from './install.js';

describe('installProviderCli vendor_recipe execution gating', () => {
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

  it('uses injected spawnSync for managed_package installs (no real processes in tests)', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-gating-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-gating-log-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      type SpawnSyncFn = typeof import('node:child_process').spawnSync;
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
          // Intentionally inject a spawnSync implementation so tests never spawn real processes.
          spawnSync: spawnSyncMock as unknown as SpawnSyncFn,
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

  it('writes install logs with private file permissions', async () => {
    if (process.platform === 'win32') return;
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-log-home-'));
    const logDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-install-log-dir-'));
    try {
      const platform = resolvePlatformFromNodePlatform(process.platform);
      expect(platform).not.toBeNull();
      if (!platform) return;

      type SpawnSyncFn = typeof import('node:child_process').spawnSync;
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
          spawnSync: spawnSyncMock as unknown as SpawnSyncFn,
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

      type SpawnSyncFn = typeof import('node:child_process').spawnSync;
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
          spawnSync: spawnSyncMock as unknown as SpawnSyncFn,
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
});
