import { describe, expect, it } from 'vitest';

import { PromptDocBodyV1Schema } from './promptDocV2.js';

describe('PromptDocBodyV1Schema', () => {
  it('preserves additive fields in prompt doc bodies', () => {
    const parsed = PromptDocBodyV1Schema.parse({
      v: 1,
      markdown: '# Hello',
      createdAtMs: 1,
      updatedAtMs: 2,
      futureDocField: 'keep-me',
    });

    expect((parsed as any).futureDocField).toBe('keep-me');
  });

  it('parses a valid prompt doc body', () => {
    const parsed = PromptDocBodyV1Schema.safeParse({
      v: 1,
      markdown: '# Hello',
      createdAtMs: 1,
      updatedAtMs: 2,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects missing fields', () => {
    const parsed = PromptDocBodyV1Schema.safeParse({ v: 1, markdown: 'x' });
    expect(parsed.success).toBe(false);
  });
});
