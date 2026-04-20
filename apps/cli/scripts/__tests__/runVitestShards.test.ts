import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { resolveVitestConfigPath, resolveVitestShardCount } from '../runVitestShards.mjs';

const { runManagedChildCommandMock } = vi.hoisted(() => ({
  runManagedChildCommandMock: vi.fn(async () => ({ ok: true as const, code: 0, signal: null as null })),
}));

vi.mock('../../../../scripts/testing/process/managedChildLifecycle.mjs', () => ({
  resolveSignalExitCode: vi.fn(() => 0),
  runManagedChildCommand: runManagedChildCommandMock,
}));

describe('runVitestShards', () => {
  it('defaults shard count to 8', () => {
    expect(resolveVitestShardCount({})).toBe(8);
  });

  it('uses HAPPIER_CLI_VITEST_SHARDS override when valid', () => {
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: '4' })).toBe(4);
  });

  it('ignores invalid shard overrides', () => {
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: '0' })).toBe(8);
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: 'nope' })).toBe(8);
  });

  it('parses --config path from argv', () => {
    expect(resolveVitestConfigPath(['node', 'run', '--config', 'vitest.integration.config.ts'])).toBe(
      'vitest.integration.config.ts',
    );
  });

  it('returns null when --config is missing', () => {
    expect(resolveVitestConfigPath(['node', 'run'])).toBe(null);
  });

  it('forwards extra vitest args after --config into each shard invocation', async () => {
    const prevArgv = process.argv.slice();
    const prevShardCount = process.env.HAPPIER_CLI_VITEST_SHARDS;

    try {
      process.env.HAPPIER_CLI_VITEST_SHARDS = '1';
      process.argv = [
        'node',
        fileURLToPath(new URL('../runVitestShards.mjs', import.meta.url)),
        '--config',
        'vitest.integration.config.ts',
        'src/backends/catalog.runtimeAdapterConsumption.integration.test.ts',
      ];

      vi.resetModules();
      await import('../runVitestShards.mjs');

      expect(runManagedChildCommandMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'vitest',
          args: [
            'run',
            '--config',
            'vitest.integration.config.ts',
            'src/backends/catalog.runtimeAdapterConsumption.integration.test.ts',
            '--shard',
            '1/1',
          ],
        }),
      );
    } finally {
      process.argv = prevArgv;
      if (prevShardCount === undefined) delete process.env.HAPPIER_CLI_VITEST_SHARDS;
      else process.env.HAPPIER_CLI_VITEST_SHARDS = prevShardCount;
    }
  });
});
