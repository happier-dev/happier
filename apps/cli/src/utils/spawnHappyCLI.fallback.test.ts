import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createSpawnHappyCliEnvScope } from '@/testkit/process/spawnHappyCliHarness';

const envScope = createSpawnHappyCliEnvScope();

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('node:fs');
  envScope.restore();
});

describe('spawnHappyCLI fallback invocation', () => {
  it('falls back to tsx source entrypoint in dev mode by default when dist entrypoint is missing', async () => {
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: undefined,
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: join(tmpdir(), `missing-happier-default-${Date.now()}`, 'index.mjs'),
    });

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

    expect(inv.runtime).toBe('node');
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        '--import',
        expect.stringMatching(/node_modules\/tsx\/dist\/esm\/index\.mjs$/),
        expect.stringMatching(/src\/index\.ts$/),
        'daemon',
        'start-sync',
      ]),
    );
    expect(inv.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    expect(process.env.TSX_TSCONFIG_PATH).toBeUndefined();
  });

  it('falls back to tsx source entrypoint in dev mode when dist entrypoint is missing', async () => {
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: '1',
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: join(tmpdir(), `missing-happier-entry-${Date.now()}`, 'index.mjs'),
    });

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

    expect(inv.runtime).toBe('node');
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        '--import',
        expect.stringMatching(/node_modules\/tsx\/dist\/esm\/index\.mjs$/),
        expect.stringMatching(/src\/index\.ts$/),
        'daemon',
        'start-sync',
      ]),
    );
    expect(inv.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    expect(process.env.TSX_TSCONFIG_PATH).toBeUndefined();
  });

  it('falls back to tsx source entrypoint in stack context even when HAPPIER_VARIANT is not set', async () => {
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_VARIANT: undefined,
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: undefined,
      HAPPIER_STACK_STACK: 'qa-agent-1',
      HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: join(tmpdir(), `missing-happier-stack-${Date.now()}`, 'index.mjs'),
    });

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

    expect(inv.runtime).toBe('node');
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        '--import',
        expect.stringMatching(/node_modules\/tsx\/dist\/esm\/index\.mjs$/),
        expect.stringMatching(/src\/index\.ts$/),
        'daemon',
        'start-sync',
      ]),
    );
    expect(inv.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    expect(process.env.TSX_TSCONFIG_PATH).toBeUndefined();
  });

  it('prefers the tsx source entrypoint in stack context even when dist exists', async () => {
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_VARIANT: undefined,
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: undefined,
      HAPPIER_STACK_STACK: 'qa-agent-1',
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: undefined,
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => {
          if (path.endsWith('dist/index.mjs')) return true;
          if (path.endsWith('src/index.ts')) return true;
          return actual.existsSync(path);
        },
      };
    });

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    const inv = mod.buildHappyCliSubprocessInvocation(['daemon', 'start-sync']);

    expect(inv.runtime).toBe('node');
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        '--import',
        expect.stringMatching(/node_modules[\\/]tsx[\\/]dist[\\/]esm[\\/]index\.mjs$/),
        expect.stringMatching(/src[\\/]index\.ts$/),
        'daemon',
        'start-sync',
      ]),
    );
    expect(inv.argv).not.toEqual(expect.arrayContaining([expect.stringMatching(/dist[\\/]index\.mjs$/)]));
    expect(inv.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    expect(process.env.TSX_TSCONFIG_PATH).toBeUndefined();
  });

  it.each(['maybe', '2', 'enabled', 'yup'])('does not treat unknown HAPPIER_CLI_SUBPROCESS_PREFER_TSX=%s as enabled', async (rawValue) => {
    envScope.patch({
      HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node',
      HAPPIER_VARIANT: undefined,
      HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK: undefined,
      HAPPIER_STACK_REPO_DIR: undefined,
      HAPPIER_STACK_CLI_ROOT_DIR: undefined,
      HAPPIER_STACK_STACK: undefined,
      HAPPIER_CLI_SUBPROCESS_PREFER_TSX: rawValue,
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => {
          if (path.endsWith('dist/index.mjs')) return true;
          if (path.endsWith('src/index.ts')) return true;
          return actual.existsSync(path);
        },
      };
    });

    const mod = (await import('@/utils/spawnHappyCLI')) as typeof import('@/utils/spawnHappyCLI');
    const inv = mod.buildHappyCliSubprocessInvocation(['--version']);

    expect(inv.runtime).toBe('node');
    expect(inv.argv).toEqual(expect.arrayContaining([expect.stringMatching(/dist[\\/]index\.mjs$/), '--version']));
    expect(inv.argv).not.toContain('--import');
  });
});
