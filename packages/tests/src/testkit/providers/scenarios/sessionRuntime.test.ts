import { describe, expect, it } from 'vitest';

import { extractAssistantCandidateTextsFromDecryptedRecord } from './sessionRuntime';

describe('sessionRuntime assistant text extraction', () => {
  it('extracts Claude output text nested in agent transcript records', () => {
    const texts = extractAssistantCandidateTextsFromDecryptedRecord({
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'FAKE_CLAUDE_OK_1' },
              { type: 'thinking', thinking: 'internal reasoning omitted' },
            ],
          },
        },
      },
    });

    expect(texts).toContain('FAKE_CLAUDE_OK_1');
  });
});
