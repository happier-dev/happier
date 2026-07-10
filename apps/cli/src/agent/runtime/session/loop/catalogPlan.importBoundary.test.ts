import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('catalogPlan import boundaries', () => {
  it('reads machine metadata from the daemon metadata owner instead of the daemon entrypoint', async () => {
    const source = await readFile(new URL('./catalogPlan.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/from ['"]@\/daemon\/startDaemon['"]/);
    expect(source).toMatch(/from ['"]@\/daemon\/machine\/metadata['"]/);
  });
});
