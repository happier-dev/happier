import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

import { pruneLogsByCount } from './pruneLogsByCount';

describe('pruneLogsByCount', () => {
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
      await expect(pruneLogsByCount({ dir, suffix: '.log', keepCount: 1, keepPath: currentPath })).resolves.toEqual({ pruned: 1 });

      await expect(readdir(dir)).resolves.toEqual([
        '2026-06-30-10-00-00-pid-1.log',
        '2026-06-30-10-02-00-pid-3.log',
      ]);
    } finally {
      removeTempDirSync(dir);
    }
  });

  it('excludes daemon logs from session log pruning', async () => {
    const dir = createTempDirSync('happier-prune-logs-');
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, '2026-06-30-10-00-00-pid-1.log'), 'session\n', 'utf8');
      await writeFile(join(dir, '2026-06-30-09-00-00-pid-99-daemon.log'), 'daemon\n', 'utf8');

      await expect(pruneLogsByCount({ dir, suffix: '.log', excludeSuffix: '-daemon.log', keepCount: 0 })).resolves.toEqual({ pruned: 1 });

      await expect(readdir(dir)).resolves.toEqual(['2026-06-30-09-00-00-pid-99-daemon.log']);
    } finally {
      removeTempDirSync(dir);
    }
  });
});
