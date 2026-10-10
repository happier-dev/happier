import { describe, expect, it } from 'vitest';

import { PromptDocBodyV1Schema, PromptDocArtifactHeaderV1Schema, PromptDocCreateActionInputV1Schema,
  resolvePromptDocCreateActionInputV1 } from './promptDocV2.js';
import { createPromptDocInLibrary } from './promptLibraryActionOperations.js';

describe('PromptDocBodyV1Schema', () => {
  it('creates only the known host starter with built-in provenance while public operands cannot claim it', async () => {
    let header: Readonly<Record<string, unknown>> | undefined;
    let body = '';
    const input = PromptDocCreateActionInputV1Schema.parse({ starter: 'happier_guide' });
    await createPromptDocInLibrary({ request: resolvePromptDocCreateActionInputV1(input), store: {
      read: async () => null, update: async () => {},
      create: async value => { header = value.header; body = value.body; return 'guide-document'; },
    } });
    expect(header).toMatchObject({ origin: 'built_in', locked: false });
    expect(JSON.parse(body)).toMatchObject({ markdown: expect.stringContaining('Make changes through existing Happier Actions') });
    for (const operand of [{ title: 'Claimed', markdown: 'Caller text', origin: 'built_in' },
      { starter: 'happier_guide', markdown: 'Caller replacement' }, { starter: 'arbitrary' }]) {
      expect(PromptDocCreateActionInputV1Schema.safeParse(operand).success).toBe(false);
    }
  });
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
