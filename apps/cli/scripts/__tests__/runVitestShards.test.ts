import { describe, expect, it } from 'vitest';

import {
  resolveVitestConfigPath,
  resolveVitestIsolationPlan,
  resolveVitestShardCount,
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
});

