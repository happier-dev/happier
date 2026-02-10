import { afterEach, describe, expect, it, vi } from 'vitest';

describe('buildHappyCliSubprocessInvocation (missing entrypoint)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('node:fs');
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.TSX_TSCONFIG_PATH;
  });

  it('throws a clear error when dist/index.mjs is missing, even under Vitest', async () => {
    vi.resetModules();
    vi.stubEnv('VITEST', '1');

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: () => false,
      };
    });

    const mod = (await import('./spawnHappyCLI')) as typeof import('./spawnHappyCLI');
    expect(() => mod.buildHappyCliSubprocessInvocation(['--version'])).toThrow(
      /Entrypoint .*dist[\\/]index\.mjs does not exist/,
    );
  });

  it('falls back to tsx entrypoint in stack dev mode when dist/index.mjs is missing', async () => {
    vi.resetModules();
    vi.stubEnv('HAPPIER_STACK_STACK', 'dev2');
    vi.stubEnv('HAPPIER_VARIANT', '');

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        existsSync: (path: string) => {
          if (path.endsWith('dist/index.mjs')) return false;
          if (path.endsWith('src/index.ts')) return true;
          return actual.existsSync(path);
        },
      };
    });

    const mod = (await import('./spawnHappyCLI')) as typeof import('./spawnHappyCLI');
    const invocation = mod.buildHappyCliSubprocessInvocation(['--version']);
    expect(invocation.argv).toContain('--import');
    expect(invocation.argv).toEqual(
      expect.arrayContaining([expect.stringMatching(/node_modules\/tsx\/dist\/esm\/index\.mjs$/)]),
    );
    expect(invocation.argv.join(' ')).toContain('src/index.ts');
    expect(invocation.env?.TSX_TSCONFIG_PATH).toEqual(expect.stringMatching(/[\\/]apps[\\/]cli[\\/]tsconfig\.json$/));
    expect(process.env.TSX_TSCONFIG_PATH).toBeUndefined();
  });
});
