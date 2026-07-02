import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('Claude unified provider transcript boundary', () => {
  it('does not own host file-follow mechanics or import CLI internals', async () => {
    const source = await readFile(new URL('./providerTranscript.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('node:fs/promises');
    expect(source).not.toContain('node:string_decoder');
    expect(source).not.toContain('setInterval');
    expect(source).not.toContain('readFileRange');
    expect(source).not.toContain('apps/cli/src');
  });
});
