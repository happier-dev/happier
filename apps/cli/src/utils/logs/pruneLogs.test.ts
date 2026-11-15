import { mkdir, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { pruneLogs } from './pruneLogs';

describe('pruneLogs', () => {
  it('keeps the newest matching logs and always keeps the current path', async () => {
    const dir = createTempDirSync('happier-prune-logs-');
    try {
      await mkdir(dir, { recursive: true });
      for (const name of [
        '2026-06-30-10-00-00-pid-1.log',
        '2026-06-30-10-01-00-pid-2.log',
        '2026-06-30-10-02-00-pid-3.log',
      ]) {
        await writeFile(join(dir, name), `${name}\n`, 'utf8');
      }

      const currentPath = join(dir, '2026-06-30-10-00-00-pid-1.log');
      await expect(pruneLogs({ dir, suffix: '.log', keepCount: 1, keepPath: currentPath })).resolves.toMatchObject({ pruned: 1 });

      await expect(readdir(dir)).resolves.toEqual([
        '2026-06-30-10-00-00-pid-1.log',
        '2026-06-30-10-02-00-pid-3.log',
      ]);
    } finally {
      removeTempDirSync(dir);
    }
  });

  it('prunes aged files without a count cap, keeps exemptions and never follows a symlink', async () => {
    const dir = createTempDirSync('happier-prune-age-');
    try {
      for (const name of ['old.log', 'current.log', 'crashed.log', 'young.log', 'outside']) {
        await writeFile(join(dir, name), name);
        await utimes(join(dir, name), 1, name === 'young.log' ? 10 : 1);
      }
      await symlink(join(dir, 'outside'), join(dir, 'link.log'));
      const result = await pruneLogs({ dir, suffix: '.log', olderThanMs: 5_000, keepPaths: [join(dir, 'current.log'), join(dir, 'crashed.log')] });
      expect(result.pruned).toBe(1);
      expect(await readdir(dir)).toEqual(['crashed.log', 'current.log', 'link.log', 'outside', 'young.log']);
    } finally { removeTempDirSync(dir); }
  });

  it('excludes daemon logs from session log pruning', async () => {
    const dir = createTempDirSync('happier-prune-logs-');
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '2026-06-30-10-00-00-pid-1.log'), 'session\n', 'utf8');
      await writeFile(join(dir, '2026-06-30-09-00-00-pid-99-daemon.log'), 'daemon\n', 'utf8');

      await expect(pruneLogs({ dir, suffix: '.log', excludeSuffix: '-daemon.log', keepCount: 0 })).resolves.toMatchObject({ pruned: 1 });

      await expect(readdir(dir)).resolves.toEqual(['2026-06-30-09-00-00-pid-99-daemon.log']);
    } finally {
      removeTempDirSync(dir);
    }
  });

  it('keeps total log bytes within the budget by removing the oldest logs first, never a kept path', async () => {
    const dir = createTempDirSync('happier-prune-budget-');
    try {
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

      const result = await pruneLogs({ dir, suffix: '.log', maxTotalBytes: 100, keepPath: join(dir, 'current-daemon.log') });

      expect(result.pruned).toBe(2);
      expect((await readdir(dir)).sort()).toEqual(['current-daemon.log', 'newer.log', 'newest.log']);
    } finally {
      removeTempDirSync(dir);
    }
  });
});
