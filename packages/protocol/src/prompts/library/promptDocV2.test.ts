import { describe, expect, it } from 'vitest';

import { PromptDocBodyV1Schema, PromptDocArtifactHeaderV1Schema } from './promptDocV2.js';

describe('PromptDocBodyV1Schema', () => {
  it('accepts stored additive fields while projecting only known prompt document content', () => {
    const parsed = PromptDocBodyV1Schema.parse({
      v: 1,
      markdown: '# Hello',
      createdAtMs: 1,
      updatedAtMs: 2,
      futureDocField: 'keep-me',
    });

    expect(parsed).not.toHaveProperty('futureDocField');
    expect(PromptDocArtifactHeaderV1Schema.parse({ v: 1, kind: 'prompt_doc.v2', title: 'Prompt',
      origin: 'imported', futureAuthority: true })).toEqual({ v: 1, kind: 'prompt_doc.v2', title: 'Prompt', origin: 'imported' });
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
