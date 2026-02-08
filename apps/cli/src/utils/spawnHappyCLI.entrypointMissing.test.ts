import { afterEach, describe, expect, it, vi } from 'vitest';

describe('buildHappyCliSubprocessInvocation (missing entrypoint)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('node:fs');
    vi.restoreAllMocks();
    vi.resetModules();
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
});
