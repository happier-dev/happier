import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const originalEntrypointOverride = process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
const originalVariant = process.env.HAPPIER_VARIANT;
const originalAllowTsxFallback = process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK;
const originalRuntime = process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
const originalStackName = process.env.HAPPIER_STACK_STACK;
const originalTsxTsconfigPath = process.env.TSX_TSCONFIG_PATH;

afterEach(() => {
  vi.resetModules();
  if (originalEntrypointOverride === undefined) delete process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
  else process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = originalEntrypointOverride;
  if (originalVariant === undefined) delete process.env.HAPPIER_VARIANT;
  else process.env.HAPPIER_VARIANT = originalVariant;
  if (originalAllowTsxFallback === undefined) delete process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK;
  else process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK = originalAllowTsxFallback;
  if (originalRuntime === undefined) delete process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME;
  else process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = originalRuntime;
  if (originalStackName === undefined) delete process.env.HAPPIER_STACK_STACK;
  else process.env.HAPPIER_STACK_STACK = originalStackName;
  if (originalTsxTsconfigPath === undefined) delete process.env.TSX_TSCONFIG_PATH;
  else process.env.TSX_TSCONFIG_PATH = originalTsxTsconfigPath;
});

describe('spawnHappyCLI fallback invocation', () => {
  it('falls back to tsx source entrypoint in dev mode by default when dist entrypoint is missing', async () => {
    process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';
    process.env.HAPPIER_VARIANT = 'dev';
    delete process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK;
    process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = join(tmpdir(), `missing-happier-default-${Date.now()}`, 'index.mjs');

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
    expect(process.env.TSX_TSCONFIG_PATH).toBe(originalTsxTsconfigPath);
  });

  it('falls back to tsx source entrypoint in dev mode when dist entrypoint is missing', async () => {
    process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';
    process.env.HAPPIER_VARIANT = 'dev';
    process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK = '1';
    process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = join(tmpdir(), `missing-happier-entry-${Date.now()}`, 'index.mjs');

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
    expect(process.env.TSX_TSCONFIG_PATH).toBe(originalTsxTsconfigPath);
  });

  it('falls back to tsx source entrypoint in stack context even when HAPPIER_VARIANT is not set', async () => {
    process.env.HAPPIER_CLI_SUBPROCESS_RUNTIME = 'node';
    delete process.env.HAPPIER_VARIANT;
    delete process.env.HAPPIER_CLI_SUBPROCESS_ALLOW_TSX_FALLBACK;
    process.env.HAPPIER_STACK_STACK = 'qa-agent-1';
    process.env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT = join(tmpdir(), `missing-happier-stack-${Date.now()}`, 'index.mjs');

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
    expect(process.env.TSX_TSCONFIG_PATH).toBe(originalTsxTsconfigPath);
  });
});
