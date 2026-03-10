import { describe, expect, it } from 'vitest';

import { buildFirstTurnPromptText } from './buildFirstTurnPromptText';

describe('buildFirstTurnPromptText', () => {
  it('prepends the explicit append system prompt on the first turn', () => {
    const result = buildFirstTurnPromptText({
      isFirstTurn: true,
      userText: 'Hello',
      appendSystemPrompt: 'APPEND',
    });

    expect(result).toEqual({
      prompt: 'APPEND\n\nHello',
      nextIsFirstTurn: false,
    });
  });

  it('uses the fallback append system prompt when no explicit override is present', () => {
    const result = buildFirstTurnPromptText({
      isFirstTurn: true,
      userText: 'Hello',
      appendSystemPrompt: undefined,
      fallbackAppendSystemPrompt: 'FALLBACK',
    });

    expect(result).toEqual({
      prompt: 'FALLBACK\n\nHello',
      nextIsFirstTurn: false,
    });
  });

  it('treats an explicit null override as disabling the fallback', () => {
    const result = buildFirstTurnPromptText({
      isFirstTurn: true,
      userText: 'Hello',
      appendSystemPrompt: null,
      fallbackAppendSystemPrompt: 'FALLBACK',
    });

    expect(result).toEqual({
      prompt: 'Hello',
      nextIsFirstTurn: true,
    });
  });

  it('returns the raw user text after the first turn', () => {
    const result = buildFirstTurnPromptText({
      isFirstTurn: false,
      userText: 'Hello',
      appendSystemPrompt: 'APPEND',
      fallbackAppendSystemPrompt: 'FALLBACK',
    });

    expect(result).toEqual({
      prompt: 'Hello',
      nextIsFirstTurn: false,
    });
  });
});
