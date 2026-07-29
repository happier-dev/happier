import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('killSession import boundaries', () => {
  it('imports logger from the logger owner instead of the public lib barrel', async () => {
    const source = await readFile(new URL('./killSession.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/from ['"]@\/lib['"]/);
    expect(source).toMatch(/from ['"]@\/ui\/logger['"]/);
  });
});
