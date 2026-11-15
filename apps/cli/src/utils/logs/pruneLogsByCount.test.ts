import { access, chmod, mkdir, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { withTempDir } from '@/testkit/fs/tempDir';
import { describe, expect, it } from 'vitest';

import { pruneLogsByCount } from './pruneLogsByCount';

async function writeFiles(dir: string, names: readonly string[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Promise.all(names.map((name) => writeFile(join(dir, name), name, 'utf8')));
}

async function listNames(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

describe('pruneLogsByCount', () => {
  it('keeps the newest matching files by filename, preserves keepPath, filters by suffix, and returns the prune count', async () => {
    await withTempDir('happier-cli-prune-logs-', async (root) => {
      const dir = join(root, 'logs');
      const oldest = '2026-06-22-10-00-00-daemon.log';
      await writeFiles(dir, [
        oldest,
        '2026-06-22-11-00-00-daemon.log',
        '2026-06-22-12-00-00-daemon.log',
        '2026-06-22-13-00-00-daemon.log',
        '2026-06-22-14-00-00-other.txt',
      ]);

      const result = await pruneLogsByCount({
        dir,
        suffix: '-daemon.log',
        keepCount: 2,
        keepPath: join(dir, oldest),
      });

      expect(result).toEqual({ pruned: 1 });
      expect(await listNames(dir)).toEqual([
        '2026-06-22-10-00-00-daemon.log',
        '2026-06-22-12-00-00-daemon.log',
        '2026-06-22-13-00-00-daemon.log',
        '2026-06-22-14-00-00-other.txt',
      ]);
    });
  });

  it('keeps only matching keepPath when keepCount is zero', async () => {
    await withTempDir('happier-cli-prune-logs-zero-', async (root) => {
      const dir = join(root, 'logs');
      const current = '2026-06-22-10-00-00-daemon.log';
      await writeFiles(dir, [
        current,
        '2026-06-22-11-00-00-daemon.log',
        '2026-06-22-12-00-00-daemon.log',
      ]);

      const result = await pruneLogsByCount({
        dir,
        suffix: '-daemon.log',
        keepCount: 0,
        keepPath: join(dir, current),
      });

      expect(result).toEqual({ pruned: 2 });
      expect(await listNames(dir)).toEqual([current]);
    });
  });

  it('excludes files matching excludeSuffix from both pruning and the keep budget', async () => {
    await withTempDir('happier-cli-prune-logs-exclude-', async (root) => {
      const dir = join(root, 'logs');
      await writeFiles(dir, [
        '2026-06-22-10-00-00-pid-1.log',
        '2026-06-22-11-00-00-pid-2.log',
        '2026-06-22-12-00-00-pid-3.log',
        '2026-06-22-09-00-00-pid-4-daemon.log',
        '2026-06-22-13-00-00-pid-5-daemon.log',
      ]);

      const result = await pruneLogsByCount({
        dir,
        suffix: '.log',
        excludeSuffix: '-daemon.log',
        keepCount: 2,
      });

      expect(result).toEqual({ pruned: 1 });
      expect(await listNames(dir)).toEqual([
        '2026-06-22-09-00-00-pid-4-daemon.log',
        '2026-06-22-11-00-00-pid-2.log',
        '2026-06-22-12-00-00-pid-3.log',
        '2026-06-22-13-00-00-pid-5-daemon.log',
      ]);
    });
  });

  it('returns zero and never throws when the directory is missing', async () => {
    await withTempDir('happier-cli-prune-logs-missing-', async (root) => {
      await expect(pruneLogsByCount({
        dir: join(root, 'missing'),
        suffix: '.log',
        keepCount: 1,
      })).resolves.toEqual({ pruned: 0 });
    });
  });

  it('treats deletion failures as non-fatal and counts only successfully removed files', async () => {
    await withTempDir('happier-cli-prune-logs-rm-failure-', async (root) => {
      const dir = join(root, 'logs');
      await writeFiles(dir, [
        '2026-06-22-10-00-00-daemon.log',
        '2026-06-22-11-00-00-daemon.log',
      ]);
      await mkdir(join(dir, '2026-06-22-09-00-00-daemon.log'));

      const result = await pruneLogsByCount({
        dir,
        suffix: '-daemon.log',
        keepCount: 1,
      });

      expect(result).toEqual({ pruned: 1 });
      expect(await listNames(dir)).toEqual([
        '2026-06-22-09-00-00-daemon.log',
        '2026-06-22-11-00-00-daemon.log',
      ]);
    });
  });

  it('returns zero and never throws when permissions deny reading the directory', async () => {
    if (process.platform === 'win32') return;

    await withTempDir('happier-cli-prune-logs-permission-', async (root) => {
      const dir = join(root, 'logs');
      await writeFiles(dir, ['2026-06-22-10-00-00-daemon.log']);
      await chmod(dir, 0o000);
      try {
        await expect(pruneLogsByCount({
          dir,
          suffix: '-daemon.log',
          keepCount: 1,
        })).resolves.toEqual({ pruned: 0 });
      } finally {
        await chmod(dir, 0o700).catch(() => {});
      }

      await expect(access(join(dir, '2026-06-22-10-00-00-daemon.log'))).resolves.toBeUndefined();
    });
  });

  it('keeps total log bytes within the budget by removing the oldest logs first, never a kept path', async () => {
    await withTempDir('happier-cli-prune-budget-', async (root) => {
      const dir = join(root, 'logs');
      await mkdir(dir, { recursive: true });
      const files = [
        { name: 'current-daemon.log', bytes: 50, mtime: 1 },
        { name: 'oldest.log', bytes: 10, mtime: 2 },
        { name: 'older.log', bytes: 30, mtime: 3 },
        { name: 'newer.log', bytes: 30, mtime: 4 },
        { name: 'newest.log', bytes: 15, mtime: 5 },
      ];
      for (const file of files) {
        await writeFile(join(dir, file.name), 'x'.repeat(file.bytes));
        await utimes(join(dir, file.name), file.mtime, file.mtime);
      }

      const result = await pruneLogsByCount({
        dir, suffix: '.log', keepCount: files.length, maxTotalBytes: 100, keepPath: join(dir, 'current-daemon.log'),
      });

      expect(result.pruned).toBe(2);
      expect(await listNames(dir)).toEqual(['current-daemon.log', 'newer.log', 'newest.log']);
    });
  });
});
