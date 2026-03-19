import { describe, expect, it } from 'vitest';

import { buildGeminiPromptForMessage } from './buildGeminiPromptForMessage';

describe('buildGeminiPromptForMessage', () => {
  it('prepends the resolved system prompt on the first message', () => {
    const res = buildGeminiPromptForMessage({
      isFirstMessage: true,
      userText: 'Hello',
      systemPromptText: 'SYSTEM',
    });

    expect(res).toEqual({ prompt: 'SYSTEM\n\nHello', nextIsFirstMessage: false });
  });

  it('does not mark first message handled when the resolved system prompt is missing', () => {
    const res = buildGeminiPromptForMessage({
      isFirstMessage: true,
      userText: 'Hello',
      systemPromptText: undefined,
    });

    expect(res).toEqual({ prompt: 'Hello', nextIsFirstMessage: true });
  });

  it('ignores blank system prompt text', () => {
    const res = buildGeminiPromptForMessage({
      isFirstMessage: true,
      userText: 'Hello',
      systemPromptText: ' ',
    });

    expect(res).toEqual({ prompt: 'Hello', nextIsFirstMessage: true });
  });

  it('returns raw text for non-first messages', () => {
    const res = buildGeminiPromptForMessage({
      isFirstMessage: false,
      userText: 'Hello',
      systemPromptText: 'SYSTEM',
    });

    expect(res).toEqual({ prompt: 'Hello', nextIsFirstMessage: false });
  });
});
