import { describe, expect, it } from 'vitest';

import { buildCodexAcpPromptForFreshSession } from './buildCodexAcpPromptForFreshSession';

describe('buildCodexAcpPromptForFreshSession', () => {
  it('prepends the resolved system prompt for a fresh session', () => {
    const prompt = buildCodexAcpPromptForFreshSession({
      prompt: 'Hello',
      startedFreshSession: true,
      systemPromptText: 'SYSTEM',
    });

    expect(prompt).toBe('SYSTEM\n\nHello');
  });

  it('returns the raw prompt when the resolved system prompt is absent', () => {
    const prompt = buildCodexAcpPromptForFreshSession({
      prompt: 'Hello',
      startedFreshSession: true,
      systemPromptText: undefined,
    });

    expect(prompt).toBe('Hello');
  });

  it('returns the raw prompt when the session was resumed', () => {
    const prompt = buildCodexAcpPromptForFreshSession({
      prompt: 'Hello',
      startedFreshSession: false,
      systemPromptText: 'SYSTEM',
    });

    expect(prompt).toBe('Hello');
  });
});
