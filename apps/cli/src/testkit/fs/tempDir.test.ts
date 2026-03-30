import { access } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('temp dir helpers', () => {
  it('creates and cleans up temporary directories', async () => {
    const tempDir = await import('@/testkit/fs/tempDir').catch(() => null);

    expect(tempDir).not.toBeNull();
    expect(tempDir?.withTempDir).toBeTypeOf('function');

    let createdDir = '';
    await tempDir!.withTempDir('happier-cli-testkit-temp-', async (dir) => {
      createdDir = dir;
      expect(dir).toContain('happier-cli-testkit-temp-');
      return undefined;
    });

    expect(createdDir).not.toBe('');
    await expect(access(createdDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
