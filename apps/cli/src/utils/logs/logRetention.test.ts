import { describe, expect, it } from 'vitest';
import { mkdir, open, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withTempDir } from '@/testkit/fs/tempDir';

import {
  resolveLogRetention,
  resolveDaemonLogKeepCount,
  resolveSessionLogKeepCount,
  createLogRetentionOwner,
  DAEMON_STDERR_LOG_PATH_ENV,
  LOG_TOTAL_BUDGET_BYTES,
} from './logRetention';
import { pruneLogs } from './pruneLogs';

describe('logRetention', () => {
  it('never offers the current daemon stderr for deletion, including zero retention', async () => {
    await withTempDir('daemon-stderr-retention-', async (root) => {
      const logsDir = join(root, 'logs');
      await mkdir(logsDir);
      const stderrPath = join(logsDir, '2026-10-26-pid-1-stderr-daemon.log');
      await writeFile(stderrPath, 'native diagnostic');
      const errors: unknown[] = [];
      const env: NodeJS.ProcessEnv = { HAPPIER_DAEMON_LOG_KEEP_COUNT: '0', [DAEMON_STDERR_LOG_PATH_ENV]: stderrPath };
      const owner = createLogRetentionOwner({
        happyHomeDir: root,
        currentLogPaths: () => [],
        env,
        onError: error => errors.push(error),
      });
      // The real prune owner calls this admission boundary before measuring or
      // deleting a candidate. A live capture must never reach that boundary.
      const attemptedDeletion = new Error('Attempted to prune live daemon stderr');
      const admission = { beforeEffect: async () => { throw attemptedDeletion; } };
      const result = await owner.run(0, Date.now(), admission);
      expect(errors).toEqual([]);
      expect(result.pruned).toBe(0);
      expect(await readFile(stderrPath, 'utf8')).toBe('native diagnostic');
      // Once this launch stops protecting the file, the existing daemon policy
      // offers the same capture for cleanup, without a new rotation policy.
      delete env[DAEMON_STDERR_LOG_PATH_ENV];
      await owner.run(0, Date.now(), admission);
      expect(errors).toEqual([attemptedDeletion]);
    });
  });

  it('only caps counts when the operator explicitly supplies a valid override', () => {
    expect(resolveDaemonLogKeepCount({})).toBeUndefined();
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: 'nope' })).toBeUndefined();
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '' })).toBeUndefined();
    expect(resolveLogRetention({ settings: { logRetentionDays: null }, env: {} })).toMatchObject({ days: null, crashedSessionKeepCount: 20 });
  });

  it('accepts zero and integer env keep counts', () => {
    expect(resolveDaemonLogKeepCount({ HAPPIER_DAEMON_LOG_KEEP_COUNT: '0' })).toBe(0);
    expect(resolveSessionLogKeepCount({ HAPPIER_SESSION_LOG_KEEP_COUNT: '2.9' })).toBe(2);
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

      await pruneLogs({ dir: root, suffix: '.log', maxTotalBytes: LOG_TOTAL_BUDGET_BYTES });

      expect((await readdir(root)).sort()).toEqual(['newest.log', 'older.log']);
    });
  });
});
