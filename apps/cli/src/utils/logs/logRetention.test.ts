import { open, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { withTempDir } from '@/testkit/fs/tempDir';
import { describe, expect, it } from 'vitest';

import {
  DAEMON_LOG_SUFFIX,
  DEFAULT_DAEMON_LOG_KEEP_COUNT,
  DEFAULT_SESSION_LOG_KEEP_COUNT,
  LOG_FILE_SUFFIX,
  resolveDaemonLogKeepCount,
  resolveSessionLogKeepCount,
  LOG_TOTAL_BUDGET_BYTES,
} from './logRetention';
import { pruneLogsByCount } from './pruneLogsByCount';

describe('logRetention', () => {
  it('exposes stable suffix constants', () => {
    expect(DAEMON_LOG_SUFFIX).toBe('-daemon.log');
    expect(LOG_FILE_SUFFIX).toBe('.log');
  });

  it('falls back to defaults when env values are missing or invalid', () => {
    expect(resolveDaemonLogKeepCount({})).toBe(DEFAULT_DAEMON_LOG_KEEP_COUNT);
    expect(resolveSessionLogKeepCount({})).toBe(DEFAULT_SESSION_LOG_KEEP_COUNT);
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: 'nope' })).toBe(DEFAULT_DAEMON_LOG_KEEP_COUNT);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '-4' })).toBe(DEFAULT_SESSION_LOG_KEEP_COUNT);
  });

  it('honors env overrides, flooring fractional values and accepting zero', () => {
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: '10' })).toBe(10);
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: '0' })).toBe(0);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '25.9' })).toBe(25);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '0' })).toBe(0);
  });

  it('keeps up to the owner-set 1 GiB of logs, newest first', async () => {
    await withTempDir('log-total-budget-', async (root) => {
      const MiB = 1024 * 1024;
      // Sparse files: the budget counts each log's size without writing a gigabyte.
      for (const [name, size, mtime] of [['newest.log', 600 * MiB, 3], ['older.log', 300 * MiB, 2], ['oldest.log', 200 * MiB, 1]] as const) {
        const handle = await open(join(root, name), 'w');
        await handle.truncate(size);
        await handle.close();
        await utimes(join(root, name), mtime, mtime);
      }

      await pruneLogsByCount({ dir: root, suffix: '.log', keepCount: Number.MAX_SAFE_INTEGER, maxTotalBytes: LOG_TOTAL_BUDGET_BYTES });

      expect((await readdir(root)).sort()).toEqual(['newest.log', 'older.log']);
    });
  });
});
