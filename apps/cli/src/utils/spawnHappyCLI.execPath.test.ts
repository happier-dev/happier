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

    try {
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
    }
  });
});
