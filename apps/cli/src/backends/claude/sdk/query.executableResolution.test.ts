import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { writeExecutableShimSync } from '@/testkit/fs/executableShim';

describe('claude sdk query executable resolution', () => {
  const originalPlatform = process.platform;
  const originalVersionsDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'bun');
  const envKeys = [
    'DEBUG',
    'HAPPIER_MANAGED_NODE_BIN',
    'HAPPIER_JS_RUNTIME_PATH',
    'HAPPIER_NODE_PATH',
    'HAPPIER_HOME_DIR',
    'PATH',
    'CLAUDECODE',
    'CLAUDE_CODE_ENTRYPOINT',
    'HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON',
  ] as const;
  let envScope = createEnvKeyScope(envKeys);

  function setBunRuntime(enabled: boolean): void {
    if (enabled) {
      Object.defineProperty(process.versions, 'bun', {
        configurable: true,
        enumerable: true,
        value: '1.0.0',
      });
      return;
    }

    if (originalVersionsDescriptor) {
      Object.defineProperty(process.versions, 'bun', originalVersionsDescriptor);
      return;
    }

    delete (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun;
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    setBunRuntime(false);
    envScope.restore();
    envScope = createEnvKeyScope(envKeys);
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uses process.execPath for JS entrypoints when executable is omitted (node runtime)', async () => {
    envScope.patch({ DEBUG: undefined });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    expect(() =>
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
        },
      }),
    ).toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
  });

  it('treats executable=\"node\" as an alias for process.execPath for JS entrypoints (node runtime)', async () => {
    envScope.patch({ DEBUG: undefined });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    expect(() =>
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          executable: 'node',
          executableArgs: [],
          pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
        },
      }),
    ).toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
  });

  it('prefers the managed node override for JS entrypoints when configured', async () => {
    await withTempDir('happier-query-managed-node-', async (overrideDir) => {
      const overridePath = writeExecutableShimSync({
        dir: overrideDir,
        fileName: process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node',
        contents: process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
      });
      envScope.patch({ HAPPIER_MANAGED_NODE_BIN: overridePath });

      const spawnMock = vi.fn((..._args: any[]) => {
        throw new Error('spawn invoked');
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return { ...actual, spawn: spawnMock };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return { ...actual, existsSync: () => true };
      });

      const { query } = (await import('./query')) as typeof import('./query');

      expect(() =>
        query({
          prompt: 'hi',
          options: {
            cwd: '/tmp',
            pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
          },
        }),
      ).toThrow(/spawn invoked/);

      expect(spawnMock).toHaveBeenCalled();
      expect(spawnMock.mock.calls[0]?.[0]).toBe(overridePath);
    });
  });

  it('treats executable="node" as a managed-runtime alias under bun', async () => {
    await withTempDir('happier-query-managed-node-bun-', async (overrideDir) => {
      const overridePath = writeExecutableShimSync({
        dir: overrideDir,
        fileName: process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node',
        contents: process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
      });
      envScope.patch({ HAPPIER_MANAGED_NODE_BIN: overridePath });
      setBunRuntime(true);
      expect(process.versions.bun).toBe('1.0.0');

      const spawnMock = vi.fn((..._args: any[]) => {
        throw new Error('spawn invoked');
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return { ...actual, spawn: spawnMock };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return { ...actual, existsSync: () => true };
      });

      const { query } = (await import('./query')) as typeof import('./query');

      expect(() =>
        query({
          prompt: 'hi',
          options: {
            cwd: '/tmp',
            executable: 'node',
            executableArgs: [],
            pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
          },
        }),
      ).toThrow(/spawn invoked/);

      expect(spawnMock).toHaveBeenCalled();
      expect(spawnMock.mock.calls[0]?.[0]).toBe(overridePath);
    });
  });

  it('fails closed for JS entrypoints under bun when executable="node" but no managed runtime is available', async () => {
    await withTempDir('happier-js-runtime-query-test-', async (happyHomeDir) => {
      const managedRuntimePath = join(
        happyHomeDir,
        'tools',
        'js-runtime',
        'current',
        'bin',
        process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime',
      );
      envScope.patch({
        HAPPIER_MANAGED_NODE_BIN: undefined,
        HAPPIER_JS_RUNTIME_PATH: undefined,
        HAPPIER_NODE_PATH: undefined,
        PATH: '',
        HAPPIER_HOME_DIR: happyHomeDir,
      });
      setBunRuntime(true);
      expect(process.versions.bun).toBe('1.0.0');

      const spawnMock = vi.fn((..._args: any[]) => {
        throw new Error('spawn invoked');
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return { ...actual, spawn: spawnMock };
      });

      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
        return {
          ...actual,
          existsSync: (path: import('node:fs').PathLike) => path !== managedRuntimePath,
        };
      });

      const { query } = (await import('./query')) as typeof import('./query');

      expect(() =>
        query({
          prompt: 'hi',
          options: {
            cwd: '/tmp',
            executable: 'node',
            executableArgs: [],
            pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
          },
        }),
      ).toThrow(/HAPPIER_MANAGED_NODE_BIN/);

      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  it('does not use shell when spawning an explicit .exe path on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    expect(() =>
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          pathToClaudeCodeExecutable: 'C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\Claude\\\\claude.exe',
        },
      }),
    ).toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(spawnOpts?.shell).not.toBe(true);
  });

  it('wraps .cmd shims with cmd.exe on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    expect(() =>
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          pathToClaudeCodeExecutable: 'C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\npm\\\\claude.cmd',
        },
      }),
    ).toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    const spawnCommand = spawnMock.mock.calls[0]?.[0] as unknown;
    const spawnArgs = spawnMock.mock.calls[0]?.[1] as unknown;
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(spawnCommand).toBe('cmd.exe');
    expect((spawnArgs as any)?.slice?.(0, 3)).toEqual(['/d', '/s', '/c']);
    expect((spawnArgs as any)?.[3]).toContain('claude.cmd');
    expect(spawnOpts?.shell).not.toBe(true);
    expect(spawnOpts?.windowsVerbatimArguments).toBe(true);
  });

  it('strips nested Claude Code env vars from the spawned process environment', async () => {
    envScope.patch({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'parent',
    });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    expect(() =>
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
        },
      }),
    ).toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, any> | undefined;
    expect(spawnOpts?.env?.CLAUDECODE).toBeUndefined();
    expect(spawnOpts?.env?.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
  });

  it('does not forward HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON into the spawned Claude process environment', async () => {
    envScope.patch({
      HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON: JSON.stringify(['GITHUB_TOKEN']),
    });

    const spawnMock = vi.fn((..._args: any[]) => {
      throw new Error('spawn invoked');
    });

    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      return { ...actual, spawn: spawnMock };
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, existsSync: () => true };
    });

    const { query } = (await import('./query')) as typeof import('./query');

    expect(() =>
      query({
        prompt: 'hi',
        options: {
          cwd: '/tmp',
          pathToClaudeCodeExecutable: '/tmp/fake-claude.cjs',
        },
      }),
    ).toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, any> | undefined;
    expect(spawnOpts?.env?.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON).toBeUndefined();
  });
});
