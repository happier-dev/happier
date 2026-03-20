import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

describe('claude sdk query executable resolution', () => {
  const originalPlatform = process.platform;
  const originalVersionsDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'bun');

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
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('uses process.execPath for JS entrypoints when executable is omitted (node runtime)', async () => {
    const prevDebug = process.env.DEBUG;
    delete process.env.DEBUG;

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

    try {
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
    } finally {
      if (typeof prevDebug === 'string') process.env.DEBUG = prevDebug;
      else delete process.env.DEBUG;
    }
  });

  it('treats executable=\"node\" as an alias for process.execPath for JS entrypoints (node runtime)', async () => {
    const prevDebug = process.env.DEBUG;
    delete process.env.DEBUG;

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

    try {
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
    } finally {
      if (typeof prevDebug === 'string') process.env.DEBUG = prevDebug;
      else delete process.env.DEBUG;
    }
  });

  it('prefers the managed node override for JS entrypoints when configured', async () => {
    const prevManagedNode = process.env.HAPPIER_MANAGED_NODE_BIN;
    const overrideDir = mkdtempSync(join(tmpdir(), 'happier-query-managed-node-'));
    const overridePath = join(overrideDir, process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node');
    writeFileSync(overridePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(overridePath, 0o755);
    process.env.HAPPIER_MANAGED_NODE_BIN = overridePath;

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

    try {
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
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
      if (typeof prevManagedNode === 'string') process.env.HAPPIER_MANAGED_NODE_BIN = prevManagedNode;
      else delete process.env.HAPPIER_MANAGED_NODE_BIN;
    }
  });

  it('treats executable="node" as a managed-runtime alias under bun', async () => {
    const prevManagedNode = process.env.HAPPIER_MANAGED_NODE_BIN;
    const overrideDir = mkdtempSync(join(tmpdir(), 'happier-query-managed-node-bun-'));
    const overridePath = join(overrideDir, process.platform === 'win32' ? 'managed-node.cmd' : 'managed-node');
    writeFileSync(overridePath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (process.platform !== 'win32') chmodSync(overridePath, 0o755);
    process.env.HAPPIER_MANAGED_NODE_BIN = overridePath;
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

    try {
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
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
      if (typeof prevManagedNode === 'string') process.env.HAPPIER_MANAGED_NODE_BIN = prevManagedNode;
      else delete process.env.HAPPIER_MANAGED_NODE_BIN;
    }
  });

  it('fails closed for JS entrypoints under bun when executable="node" but no managed runtime is available', async () => {
    const prevManagedNode = process.env.HAPPIER_MANAGED_NODE_BIN;
    const prevRuntimePath = process.env.HAPPIER_JS_RUNTIME_PATH;
    const prevNodePath = process.env.HAPPIER_NODE_PATH;
    const prevHappyHomeDir = process.env.HAPPIER_HOME_DIR;
    const prevPath = process.env.PATH;
    const happyHomeDir = join(tmpdir(), `happier-js-runtime-query-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const managedRuntimePath = join(
      happyHomeDir,
      'tools',
      'js-runtime',
      'current',
      'bin',
      process.platform === 'win32' ? 'happier-js-runtime.cmd' : 'happier-js-runtime',
    );
    delete process.env.HAPPIER_MANAGED_NODE_BIN;
    delete process.env.HAPPIER_JS_RUNTIME_PATH;
    delete process.env.HAPPIER_NODE_PATH;
    process.env.PATH = '';
    rmSync(happyHomeDir, { recursive: true, force: true });
    process.env.HAPPIER_HOME_DIR = happyHomeDir;
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

    try {
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
    } finally {
      if (typeof prevManagedNode === 'string') process.env.HAPPIER_MANAGED_NODE_BIN = prevManagedNode;
      else delete process.env.HAPPIER_MANAGED_NODE_BIN;
      if (typeof prevRuntimePath === 'string') process.env.HAPPIER_JS_RUNTIME_PATH = prevRuntimePath;
      else delete process.env.HAPPIER_JS_RUNTIME_PATH;
      if (typeof prevNodePath === 'string') process.env.HAPPIER_NODE_PATH = prevNodePath;
      else delete process.env.HAPPIER_NODE_PATH;
      if (typeof prevHappyHomeDir === 'string') process.env.HAPPIER_HOME_DIR = prevHappyHomeDir;
      else delete process.env.HAPPIER_HOME_DIR;
      if (typeof prevPath === 'string') process.env.PATH = prevPath;
      else delete process.env.PATH;
      rmSync(happyHomeDir, { recursive: true, force: true });
    }
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
    const prevClaudeCode = process.env.CLAUDECODE;
    const prevEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'parent';

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

    try {
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
    } finally {
      if (typeof prevClaudeCode === 'string') process.env.CLAUDECODE = prevClaudeCode;
      else delete process.env.CLAUDECODE;
      if (typeof prevEntrypoint === 'string') process.env.CLAUDE_CODE_ENTRYPOINT = prevEntrypoint;
      else delete process.env.CLAUDE_CODE_ENTRYPOINT;
    }
  });

  it('does not forward HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON into the spawned Claude process environment', async () => {
    const prev = process.env.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON;
    process.env.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON = JSON.stringify(['GITHUB_TOKEN']);

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

    try {
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
    } finally {
      if (typeof prev === 'string') process.env.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON = prev;
      else delete process.env.HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON;
    }
  });
});
