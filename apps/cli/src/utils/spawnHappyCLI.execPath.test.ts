import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { withTempDir } from '@/testkit/fs/tempDir';
import {
  createSpawnHappyCliEnvScope,
  withTempHappyCliEntrypoint,
} from '@/testkit/process/spawnHappyCliHarness';

describe('spawnHappyCLI runtime executable selection', () => {
  const envScope = createSpawnHappyCliEnvScope();
  const originalGlobalBun = (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  afterEach(() => {
    vi.doUnmock('child_process');
    vi.resetModules();
    vi.restoreAllMocks();
    envScope.restore();

    if (originalGlobalBun === undefined) {
      delete (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
    } else {
      (globalThis as typeof globalThis & { Bun?: unknown }).Bun = originalGlobalBun;
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('spawns Node using process.execPath when subprocess runtime is node', async () => {
    const spawnMock = vi.fn();
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      return { ...actual, spawn: spawnMock };
    });

    await withTempHappyCliEntrypoint(async (entrypoint) => {
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      mod.spawnHappyCLI(['--version']);

      expect(spawnMock).toHaveBeenCalled();
      expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
    });
  });

  it('keeps API Tokens and CLI continuation handoffs out of generic Happier children', async () => {
    const spawnMock = vi.fn();
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      return { ...actual, spawn: spawnMock };
    });

    await withTempHappyCliEntrypoint(async (entrypoint) => {
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      mod.spawnHappyCLI(['--version'], {
        env: {
          PATH: '/bin',
          HAPPIER_TOKEN: 'hap_v1_ambient_token_secret',
          HAPPIER_CLI_API_TOKEN_HANDOFF_V1: 'hap_v1_handoff_token_secret',
        },
      });

      const childEnv = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv | undefined;
      expect(childEnv?.HAPPIER_TOKEN).toBeUndefined();
      expect(childEnv?.HAPPIER_CLI_API_TOKEN_HANDOFF_V1).toBeUndefined();
    });
  });

  it('spawns using the bun binary name when subprocess runtime is bun (not running under bun)', async () => {
    const spawnMock = vi.fn();
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      return { ...actual, spawn: spawnMock };
    });

    await withTempHappyCliEntrypoint(async (entrypoint) => {
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'bun',
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      mod.spawnHappyCLI(['--version']);

      expect(spawnMock).toHaveBeenCalled();
      expect(spawnMock.mock.calls[0]?.[0]).toBe('bun');
    });
  });

  it('uses the resolved JavaScript runtime under bun when subprocess runtime is node', async () => {
    const spawnMock = vi.fn();
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      return { ...actual, spawn: spawnMock };
    });

    await withTempDir('happier-managed-node-', async (dir) => {
      const runtimePath = join(dir, process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node');
      mkdirSync(dir, { recursive: true });
      writeFileSync(runtimePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
      if (process.platform !== 'win32') {
        const { chmodSync } = await import('node:fs');
        chmodSync(runtimePath, 0o755);
      }

      (globalThis as typeof globalThis & { Bun?: unknown }).Bun = {};
      await withTempHappyCliEntrypoint(async (entrypoint) => {
        envScope.patch({
          HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
          HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
          HAPPIER_MANAGED_NODE_BIN: runtimePath,
        });

        const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
        mod.spawnHappyCLI(['--version']);

        expect(spawnMock).toHaveBeenCalled();
        expect(spawnMock.mock.calls[0]?.[0]).toBe(runtimePath);
      });
    });
  });

  it('resolves a node-compatible runtime when subprocess runtime is node and no explicit runtime override is configured', async () => {
    (globalThis as typeof globalThis & { Bun?: unknown }).Bun = {};
    await withTempHappyCliEntrypoint(async (entrypoint) => {
      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
        HAPPIER_MANAGED_NODE_BIN: undefined,
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const launchSpec = mod.buildHappyCliSubprocessLaunchSpec(['--version']);

      expect(launchSpec).toMatchObject({
        runtime: 'node',
      });
      expect(launchSpec.filePath).toMatch(/node(?:\.exe)?$/i);
    });
  });

  it('prefers the sibling packaged Windows binary for daemon session runners when requested', async () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform descriptor to be available');
    }

    await withTempDir('happier-windows-package-', async (dir) => {
      const packageDistDir = join(dir, 'package-dist');
      const entrypoint = join(packageDistDir, 'index.mjs');
      const binaryPath = join(dir, 'happier.exe');
      mkdirSync(packageDistDir, { recursive: true });
      writeFileSync(entrypoint, 'export {};\n', 'utf8');
      writeFileSync(binaryPath, '', 'utf8');

      Object.defineProperty(process, 'platform', {
        ...originalPlatformDescriptor,
        value: 'win32',
      });

      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
        HAPPIER_VARIANT: undefined,
        HAPPIER_STACK_REPO_DIR: undefined,
        HAPPIER_STACK_CLI_ROOT_DIR: undefined,
        HAPPIER_STACK_STACK: undefined,
        HAPPIER_WINDOWS_SESSION_RUNNER_BINARY: undefined,
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const launchSpec = mod.buildHappyCliSubprocessLaunchSpec(['codex', '--started-by', 'daemon'], {
        preferWindowsPackagedBinary: true,
      });

      expect(launchSpec.runtime).toBe('binary');
      expect(launchSpec.filePath).toBe(binaryPath);
      expect(launchSpec.args).toEqual(['codex', '--started-by', 'daemon']);
    });
  });

  it('falls back to the JavaScript runtime when the Windows session runner binary preference is disabled', async () => {
    if (!originalPlatformDescriptor) {
      throw new Error('Expected process.platform descriptor to be available');
    }

    await withTempDir('happier-windows-package-disabled-', async (dir) => {
      const packageDistDir = join(dir, 'package-dist');
      const entrypoint = join(packageDistDir, 'index.mjs');
      const binaryPath = join(dir, 'happier.exe');
      mkdirSync(packageDistDir, { recursive: true });
      writeFileSync(entrypoint, 'export {};\n', 'utf8');
      writeFileSync(binaryPath, '', 'utf8');

      Object.defineProperty(process, 'platform', {
        ...originalPlatformDescriptor,
        value: 'win32',
      });

      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
        HAPPIER_VARIANT: undefined,
        HAPPIER_STACK_REPO_DIR: undefined,
        HAPPIER_STACK_CLI_ROOT_DIR: undefined,
        HAPPIER_STACK_STACK: undefined,
        HAPPIER_WINDOWS_SESSION_RUNNER_BINARY: '0',
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const launchSpec = mod.buildHappyCliSubprocessLaunchSpec(['codex', '--started-by', 'daemon'], {
        preferWindowsPackagedBinary: true,
      });

      expect(launchSpec.runtime).toBe('node');
      expect(launchSpec.filePath).not.toBe(binaryPath);
      expect(launchSpec.args).toEqual(expect.arrayContaining([
        '--no-warnings',
        '--no-deprecation',
        entrypoint,
        'codex',
        '--started-by',
        'daemon',
      ]));
    });
  });

  it('reuses the current self-contained binary when dist entrypoint is missing without a runtime override', async () => {
    const originalArgv = [...process.argv];
    const originalExecPath = process.execPath;

    try {
      process.argv = ['/Applications/Happier.app/Contents/MacOS/happier', '/$bunfs/root/happier-linux-arm64', 'daemon', 'start-sync'];
      Object.defineProperty(process, 'execPath', {
        value: '/Applications/Happier.app/Contents/MacOS/happier',
        configurable: true,
      });

      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: '/$bunfs/dist/index.mjs',
        HAPPIER_CLI_SUBPROCESS_RUNTIME: undefined,
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
        HAPPIER_VARIANT: undefined,
        HAPPIER_STACK_REPO_DIR: undefined,
        HAPPIER_STACK_CLI_ROOT_DIR: undefined,
        HAPPIER_STACK_STACK: undefined,
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const launchSpec = mod.buildHappyCliSubprocessLaunchSpec(['daemon', 'start-sync']);

      expect(launchSpec.runtime).toBe('bun');
      expect(launchSpec.filePath).toBe('/Applications/Happier.app/Contents/MacOS/happier');
      expect(launchSpec.args).toEqual(['daemon', 'start-sync']);
    } finally {
      process.argv = originalArgv;
      Object.defineProperty(process, 'execPath', {
        value: originalExecPath,
        configurable: true,
      });
    }
  });

  it('reuses the current bundled bun script when dist entrypoint is missing without a runtime override', async () => {
    const originalArgv = [...process.argv];
    const originalExecPath = process.execPath;
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalHappyHomeDir = process.env.HAPPIER_HOME_DIR;

    try {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'linux' });
      process.env.HAPPIER_HOME_DIR = '/tmp/happier-cli-test-home';
      process.argv = ['bun', '/$bunfs/root/happier-linux-arm64', 'daemon', 'start'];
      Object.defineProperty(process, 'execPath', {
        value: '/usr/bin/bun',
        configurable: true,
      });

      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: '/$bunfs/dist/index.mjs',
        HAPPIER_CLI_SUBPROCESS_RUNTIME: undefined,
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
        HAPPIER_VARIANT: undefined,
        HAPPIER_STACK_REPO_DIR: undefined,
        HAPPIER_STACK_CLI_ROOT_DIR: undefined,
        HAPPIER_STACK_STACK: undefined,
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      const launchSpec = mod.buildHappyCliSubprocessLaunchSpec(['daemon', 'start-sync']);

      expect(launchSpec.runtime).toBe('bun');
      expect(launchSpec.filePath).toBe('/usr/bin/bun');
      expect(launchSpec.args).toEqual(['/$bunfs/root/happier-linux-arm64', 'daemon', 'start-sync']);
    } finally {
      process.argv = originalArgv;
      Object.defineProperty(process, 'execPath', {
        value: originalExecPath,
        configurable: true,
      });
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
      }
      if (originalHappyHomeDir === undefined) {
        delete process.env.HAPPIER_HOME_DIR;
      } else {
        process.env.HAPPIER_HOME_DIR = originalHappyHomeDir;
      }
    }
  });

  it('fails closed on Windows when only an embedded bun bundle script path is available', async () => {
    const originalArgv = [...process.argv];
    const originalExecPath = process.execPath;
    const originalPlatformDescriptorInner = Object.getOwnPropertyDescriptor(process, 'platform');

    try {
      process.argv = ['bun', 'B:/~BUN/root/happier.exe', 'daemon', 'start'];
      Object.defineProperty(process, 'execPath', {
        value: 'C:\\Program Files\\Bun\\bun.exe',
        configurable: true,
      });
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptorInner, value: 'win32' });

      envScope.patch({
        HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: 'B:/~BUN/dist/index.mjs',
        HAPPIER_CLI_SUBPROCESS_RUNTIME: undefined,
        HAPPIER_CLI_SUBPROCESS_PREFER_TSX: '0',
        HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '0',
        HAPPIER_VARIANT: undefined,
        HAPPIER_STACK_REPO_DIR: undefined,
        HAPPIER_STACK_CLI_ROOT_DIR: undefined,
        HAPPIER_STACK_STACK: undefined,
      });

      const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
      expect(() => mod.buildHappyCliSubprocessLaunchSpec(['daemon', 'start-sync'])).toThrow(
        /Entrypoint .* does not exist/,
      );
    } finally {
      process.argv = originalArgv;
      Object.defineProperty(process, 'execPath', {
        value: originalExecPath,
        configurable: true,
      });
      if (originalPlatformDescriptorInner) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptorInner);
      }
    }
  });
});
