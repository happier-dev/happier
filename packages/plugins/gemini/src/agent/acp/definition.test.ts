import { describe, expect, it } from 'vitest';

import { GEMINI_ACP_RUNTIME_DEFINITION } from './definition.js';

describe('GEMINI_ACP_RUNTIME_DEFINITION', () => {
  it('declares the provider-owned native ACP policy', () => {
    expect(GEMINI_ACP_RUNTIME_DEFINITION).toMatchObject({
      modelConfigOptionId: 'model',
      timeouts: {
        initMs: 120_000,
        idleMs: 500,
        toolCallMs: 120_000,
      },
      mcp: {
        policy: 'pass_through',
      },
    });
  });

  it('keeps Gemini stderr and tool-name dialects provider-owned', () => {
    expect(GEMINI_ACP_RUNTIME_DEFINITION.stderrRules?.statusErrors).toEqual([
      expect.objectContaining({
        includes: ['status 404', 'code":404'],
        detail: expect.stringContaining('Suggested models:'),
      }),
    ]);
    expect(GEMINI_ACP_RUNTIME_DEFINITION.toolNameInference).toMatchObject({
      preferLongestPattern: true,
      unknownToolNames: ['other', 'unknown', 'unknown tool', 'Unknown tool'],
      patterns: expect.arrayContaining([
        expect.objectContaining({ name: 'change_title' }),
        expect.objectContaining({ name: 'read' }),
        expect.objectContaining({ name: 'write' }),
        expect.objectContaining({ name: 'execute' }),
      ]),
    });
  });
});
