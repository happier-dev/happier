import { describe, expect, it } from 'vitest';

import { canonicalizeToolNameV2, normalizeToolCallV2 } from './index';

describe('canonicalizeToolNameV2', () => {
  it('keeps Delete inference for write tool names', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'write',
        toolInput: { title: 'Delete foo.txt' },
      }),
    ).toBe('Delete');
  });

  it('keeps Delete inference for edit tool names', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'edit',
        toolInput: { title: 'Delete foo.txt' },
      }),
    ).toBe('Delete');
  });

  it('infers CodeSearch for unknown tool names that carry a query', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { query: 'SEARCH_ME', description: 'Searching for: SEARCH_ME' },
      }),
    ).toBe('CodeSearch');
  });

  it('does not infer CodeSearch for unknown tool names that only carry freeform text', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { text: 'Something went wrong' },
      }),
    ).toBe('unknown');
  });

  it('infers CodeSearch for unknown tool names when text is paired with a location hint', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { text: 'needle', path: 'src/index.ts' },
      }),
    ).toBe('CodeSearch');
  });

  it('does not infer CodeSearch when locations is present but empty', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: { text: 'needle', locations: [] },
      }),
    ).toBe('unknown');
  });

  it('infers Read for unknown ACP tools labeled as ReadFile', () => {
    expect(
      canonicalizeToolNameV2({
        protocol: 'acp',
        toolName: 'unknown',
        toolInput: {
          description: 'ReadFile',
          _acp: { title: 'ReadFile' },
          items: [{ content: { text: '{"path":"README.md"}', type: 'text' }, type: 'content' }],
        },
      }),
    ).toBe('Read');
  });
});

describe('normalizeToolCallV2', () => {
  it('keeps edit entries non-empty when file path is provided at the tool-call level', () => {
    const normalized = normalizeToolCallV2({
      protocol: 'acp',
      provider: 'example-provider',
      toolName: 'edit',
      callId: 'tool-1',
      rawInput: {
        path: 'src/example.ts',
        edits: [{ oldText: 'before', newText: 'after' }],
      },
    });

    expect(normalized.canonicalToolName).toBe('MultiEdit');
    expect(normalized.input).toMatchObject({
      file_path: 'src/example.ts',
      edits: [
        {
          file_path: 'src/example.ts',
          old_string: 'before',
          new_string: 'after',
        },
      ],
      _happier: expect.objectContaining({
        protocol: 'acp',
        provider: 'example-provider',
        rawToolName: 'edit',
        canonicalToolName: 'MultiEdit',
      }),
    });
  });
});
