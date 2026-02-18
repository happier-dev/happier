import { afterEach, describe, expect, it, vi } from 'vitest';

describe('claude sdk query executable resolution', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
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

  it('uses shell when spawning the global \"claude\" command on Windows', async () => {
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
          pathToClaudeCodeExecutable: 'claude',
        },
      }),
    ).toThrow(/spawn invoked/);

    expect(spawnMock).toHaveBeenCalled();
    const spawnOpts = spawnMock.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(spawnOpts?.shell).toBe(true);
  });
});
