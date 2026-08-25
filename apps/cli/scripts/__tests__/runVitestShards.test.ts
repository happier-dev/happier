import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  buildVitestListArgs,
  buildVitestShardArgs,
  resolveCliVitestLaneAdmission,
  resolveVitestConfigPath,
  resolveVitestShardCount,
  resolveVitestShardRange,
  runCliVitestShardRuns,
} from '../runVitestShards.mjs';

const { runManagedChildCommandMock } = vi.hoisted(() => ({
  // The lane collection pass runs `vitest list --filesOnly --json <path>` before any
  // shard, so this stands in for the real writer rather than leaving the file absent.
  runManagedChildCommandMock: vi.fn(async (input: Readonly<{ args?: readonly string[] }>) => {
    const args = input?.args ?? [];
    const jsonIndex = args.indexOf('--json');
    if (args[0] === 'list' && jsonIndex !== -1 && typeof args[jsonIndex + 1] === 'string') {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        args[jsonIndex + 1]!,
        JSON.stringify([{ file: 'src/backends/catalog.runtimeAdapterConsumption.integration.test.ts' }]),
        'utf8',
      );
    }
    return { ok: true as const, code: 0, signal: null as null };
  }),
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

  it('partitions the configured shard count into balanced CI parts', () => {
    expect(resolveVitestShardRange({ HAPPIER_CLI_VITEST_PART: '1', HAPPIER_CLI_VITEST_PARTS: '2' }, 8))
      .toEqual({ start: 1, end: 4, part: 1, parts: 2 });
    expect(resolveVitestShardRange({ HAPPIER_CLI_VITEST_PART: '2', HAPPIER_CLI_VITEST_PARTS: '2' }, 8))
      .toEqual({ start: 5, end: 8, part: 2, parts: 2 });
    expect(resolveVitestShardRange({}, 8)).toEqual({ start: 1, end: 8, part: 1, parts: 1 });
  });

  it('lets an empty shard exit cleanly without making a hand-selected empty run green', () => {
    // `--shard N/M` legitimately yields empty shards, so the shard runner asks
    // for `--passWithNoTests` itself. It must NOT live in the config, or a
    // directly invoked selected pattern that collects nothing (CI does this at
    // .github/workflows/tests.yml for src/daemon/daemon.integration.test.ts)
    // would exit green after the file is renamed or moved.
    expect(buildVitestShardArgs({
      configPath: 'vitest.integration.config.ts',
      shardSpec: '2/8',
      vitestArgs: ['--testTimeout', '15000'],
    })).toEqual([
      'run',
      '--config',
      'vitest.integration.config.ts',
      '--testTimeout',
      '15000',
      '--passWithNoTests',
      '--shard',
      '2/8',
    ]);
  });

  it('parses --config path from argv', () => {
    expect(resolveVitestConfigPath(['node', 'run', '--config', 'vitest.integration.config.ts'])).toBe(
      'vitest.integration.config.ts',
    );
  });

  it('returns null when --config is missing', () => {
    expect(resolveVitestConfigPath(['node', 'run'])).toBe(null);
  });

  it('runs every later shard after an earlier shard fails', async () => {
    const runShard = vi.fn()
      .mockResolvedValueOnce({ ok: true, code: 1, signal: null })
      .mockResolvedValueOnce({ ok: true, code: 0, signal: null })
      .mockResolvedValueOnce({ ok: true, code: 1, signal: null });

    const outcomes = await runCliVitestShardRuns({ shardCount: 3, runShard });

    expect(runShard.mock.calls.map(([entry]) => entry.shardSpec)).toEqual(['1/3', '2/3', '3/3']);
    expect(outcomes.map((entry) => entry.outcome)).toEqual(['failed', 'passed', 'failed']);
  });

  it('runs only the assigned absolute shard range', async () => {
    const runShard = vi.fn().mockResolvedValue({ ok: true, code: 0, signal: null });
    const outcomes = await runCliVitestShardRuns({ shardCount: 8, startShard: 5, endShard: 8, runShard });
    expect(runShard.mock.calls.map(([entry]) => entry.shardSpec)).toEqual(['5/8', '6/8', '7/8', '8/8']);
    expect(outcomes.map((entry) => entry.shardSpec)).toEqual(['5/8', '6/8', '7/8', '8/8']);
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

      // `main` is only voided at module scope, and the lane collection pass now runs
      // before the first shard, so the shard spawn lands after the import settles.
      await vi.waitFor(() => {
        expect(runManagedChildCommandMock).toHaveBeenCalledWith(
          expect.objectContaining({
            command: 'vitest',
            args: [
              'run',
              '--config',
              'vitest.integration.config.ts',
              'src/backends/catalog.runtimeAdapterConsumption.integration.test.ts',
              '--passWithNoTests',
              '--shard',
              '1/1',
            ],
          }),
        );
      });
    } finally {
      process.argv = prevArgv;
      if (prevShardCount === undefined) delete process.env.HAPPIER_CLI_VITEST_SHARDS;
      else process.env.HAPPIER_CLI_VITEST_SHARDS = prevShardCount;
    }
  });

  it('refuses to report a sharded lane green when the whole lane collected nothing', async () => {
    // Every shard asks for `--passWithNoTests` because `--shard N/M` legitimately
    // produces empty shards. Keeping the flag out of the lane config only protects a
    // direct `vitest run`; the sharded lane CI actually runs
    // (.github/workflows/tests.yml `yarn workspace @happier-dev/cli test:integration`)
    // still printed `8 shard(s) ran of 8: 8 passed` and exited 0 for zero collected
    // tests. The lane-level collection question is the one no single shard can answer.
    await expect(resolveCliVitestLaneAdmission({
      configPath: 'vitest.integration.config.ts',
      nodeOptions: '',
      vitestArgs: ['src/typo-that-matches-nothing'],
      listTestFiles: async () => [],
    })).resolves.toEqual({ admitted: false, fileCount: 0 });
  });

  it('admits an explicitly requested empty lane and any lane that collected files', async () => {
    await expect(resolveCliVitestLaneAdmission({
      configPath: 'vitest.integration.config.ts',
      nodeOptions: '',
      vitestArgs: ['--passWithNoTests'],
      listTestFiles: async () => [],
    })).resolves.toEqual({ admitted: true, fileCount: 0 });

    await expect(resolveCliVitestLaneAdmission({
      configPath: 'vitest.integration.config.ts',
      nodeOptions: '',
      vitestArgs: [],
      listTestFiles: async () => ['src/a.integration.test.ts'],
    })).resolves.toEqual({ admitted: true, fileCount: 1 });
  });

  it('collects the lane through the same config and caller filters the shards use', () => {
    expect(buildVitestListArgs({
      configPath: 'vitest.integration.config.ts',
      vitestArgs: ['src/daemon'],
      jsonPath: '/tmp/happier-cli-vitest-list/files.json',
    })).toEqual([
      'list',
      '--config',
      'vitest.integration.config.ts',
      'src/daemon',
      '--filesOnly',
      '--json',
      '/tmp/happier-cli-vitest-list/files.json',
    ]);
  });
});
