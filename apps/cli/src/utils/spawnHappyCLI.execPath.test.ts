import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('spawnHappyCLI runtime executable selection', () => {
  const originalRuntime = process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
  const originalEntrypointOverride = process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;

  afterEach(() => {
    vi.doUnmock('child_process');
    vi.resetModules();
    vi.restoreAllMocks();

    if (originalRuntime === undefined) delete process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
    else process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = originalRuntime;

    if (originalEntrypointOverride === undefined) delete process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
    else process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = originalEntrypointOverride;
  });

  function writeTempEntrypoint(): string {
    const dir = join(tmpdir(), `happier-cli-entrypoint-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const entrypoint = join(dir, 'index.mjs');
    writeFileSync(entrypoint, 'export {};\n', 'utf8');
    return entrypoint;
  }

  it('spawns Node using process.execPath when subprocess runtime is node', async () => {
    const spawnMock = vi.fn();
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      return { ...actual, spawn: spawnMock };
    });

    process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';
    process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = writeTempEntrypoint();

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    mod.spawnHappyCLI(['--version']);

    expect(spawnMock).toHaveBeenCalled();
    expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath);
  });

  it('spawns using the bun binary name when subprocess runtime is bun (not running under bun)', async () => {
    const spawnMock = vi.fn();
    vi.doMock('child_process', async () => {
      const actual = await vi.importActual<typeof import('child_process')>('child_process');
      return { ...actual, spawn: spawnMock };
    });

    process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'bun';
    process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = writeTempEntrypoint();

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    mod.spawnHappyCLI(['--version']);

    expect(spawnMock).toHaveBeenCalled();
    expect(spawnMock.mock.calls[0]?.[0]).toBe('bun');
  });
});

