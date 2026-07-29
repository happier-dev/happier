import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('plugin ACP definition import boundaries', () => {
  it('normalizes plugin ACP definitions without importing runtime construction', async () => {
    const source = await readFile(new URL('./plugin.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/from ['"]\.\/runtimeCore['"]/);
  });
});
