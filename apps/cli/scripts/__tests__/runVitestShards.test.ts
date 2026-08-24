import { describe, expect, it, vi } from 'vitest';

import {
  resolveVitestConfigPath,
  resolveVitestIsolationPlan,
  resolveVitestShardRange,
  resolveVitestShardCount,
  runCliVitestShardRuns,
} from '../runVitestShards.mjs';

describe('runVitestShards', () => {
  it('uses a smaller per-process unit slice while retaining the integration default', () => {
    expect(resolveVitestShardCount({}, 'vitest.config.ts')).toBe(64);
    expect(resolveVitestShardCount({}, 'vitest.integration.config.ts')).toBe(8);
  });

  it('uses HAPPIER_CLI_VITEST_SHARDS override when valid', () => {
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: '4' }, 'vitest.config.ts')).toBe(4);
  });

  it('ignores invalid shard overrides', () => {
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: '0' }, 'vitest.config.ts')).toBe(64);
    expect(resolveVitestShardCount({ HAPPIER_CLI_VITEST_SHARDS: 'nope' }, 'vitest.config.ts')).toBe(64);
  });

  it('partitions the configured shard count into balanced CI parts', () => {
    expect(resolveVitestShardRange({ HAPPIER_CLI_VITEST_PART: '1', HAPPIER_CLI_VITEST_PARTS: '2' }, 64)).toEqual({
      start: 1,
      end: 32,
      part: 1,
      parts: 2,
    });
    expect(resolveVitestShardRange({ HAPPIER_CLI_VITEST_PART: '2', HAPPIER_CLI_VITEST_PARTS: '2' }, 8)).toEqual({
      start: 5,
      end: 8,
      part: 2,
      parts: 2,
    });
  });

  it('runs the full shard range when partition inputs are absent or invalid', () => {
    expect(resolveVitestShardRange({}, 8)).toEqual({ start: 1, end: 8, part: 1, parts: 1 });
    expect(resolveVitestShardRange({ HAPPIER_CLI_VITEST_PART: '3', HAPPIER_CLI_VITEST_PARTS: '2' }, 8)).toEqual({
      start: 1,
      end: 8,
      part: 1,
      parts: 1,
    });
  });

  it('runs the reset-heavy daemon service suite in two fresh processes', () => {
    expect(resolveVitestIsolationPlan('vitest.config.ts')).toEqual({
      shardExcludes: ['src/daemon/service/cli.test.ts'],
      runs: [
        {
          file: 'src/daemon/service/cli.test.ts',
          testNamePattern: 'runDaemonServiceCliCommand (?:allows|expands|prefers|resolves|restarts|restores|sets|treats)\\b',
        },
        {
          file: 'src/daemon/service/cli.test.ts',
          testNamePattern: 'runDaemonServiceCliCommand (?:defaults|fails|plans|refreshes|reports|stops|supports|uses)\\b',
        },
        {
          file: 'src/daemon/service/cli.test.ts',
          testNamePattern: 'runDaemonServiceCliCommand (?:builds|includes|keeps|passes|rejects|respects|scopes|uninstalls)\\b',
        },
      ],
    });
    expect(resolveVitestIsolationPlan('vitest.integration.config.ts')).toEqual({
      shardExcludes: [],
      runs: [],
    });
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

    expect(runShard.mock.calls.map(([entry]) => entry.shard)).toEqual([1, 2, 3]);
    expect(outcomes.map((entry) => entry.outcome)).toEqual(['failed', 'passed', 'failed']);
  });

  it('runs only the assigned absolute shard range', async () => {
    const runShard = vi.fn().mockResolvedValue({ ok: true, code: 0, signal: null });

    const outcomes = await runCliVitestShardRuns({ shardCount: 8, startShard: 5, endShard: 8, runShard });

    expect(runShard.mock.calls.map(([entry]) => entry.shard)).toEqual([5, 6, 7, 8]);
    expect(outcomes.map((entry) => entry.shard)).toEqual([5, 6, 7, 8]);
  });
});
