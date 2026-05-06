import { describe, expect, it } from 'vitest';

import { buildFirstTurnPromptText } from './buildFirstTurnPromptText';

describe('buildFirstTurnPromptText', () => {
  it('prepends the resolved system prompt on the first turn', () => {
    const result = buildFirstTurnPromptText({
      isFirstTurn: true,
      userText: 'Hello',
      systemPromptText: 'SYSTEM',
    });

    expect(result).toEqual({
      prompt: 'SYSTEM\n\nHello',
      nextIsFirstTurn: false,
    });
  });

  it('keeps waiting for a system prompt when the first turn has none yet', () => {
    const result = buildFirstTurnPromptText({
      isFirstTurn: true,
      userText: 'Hello',
      systemPromptText: undefined,
    });

    expect(result).toEqual({
      prompt: 'Hello',
      nextIsFirstTurn: true,
    });
  });

  it('treats blank system prompt text as absent', () => {
    const result = buildFirstTurnPromptText({
      isFirstTurn: true,
      userText: 'Hello',
      systemPromptText: '   ',
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
      systemPromptText: 'SYSTEM',
    });

    expect(result).toEqual({
      prompt: 'Hello',
      nextIsFirstTurn: false,
    });
  });
});
