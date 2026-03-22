import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from './tempDir';
import { withTempDir } from './withTempDir';

describe('testkit fs tempDir', () => {
  it('creates a temp dir with the requested prefix', async () => {
    const dir = await createTempDir({ prefix: 'happier-tests-tempdir-' });
    try {
      expect(existsSync(dir)).toBe(true);
      expect(dir).toContain('happier-tests-tempdir-');
    } finally {
      await removeTempDir(dir);
    }
  });

  it('cleans up a temp dir after withTempDir returns', async () => {
    let createdDir = '';

    const result = await withTempDir({ prefix: 'happier-tests-with-tempdir-' }, async (dir) => {
      createdDir = dir;
      expect(existsSync(dir)).toBe(true);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(createdDir).not.toBe('');
    expect(existsSync(createdDir)).toBe(false);
  });
});
