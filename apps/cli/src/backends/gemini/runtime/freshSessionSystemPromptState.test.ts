import { describe, expect, it } from 'vitest';

import { resolveShouldPrependAppendSystemPromptOnNextFreshSessionPrompt } from './freshSessionSystemPromptState';

describe('resolveShouldPrependAppendSystemPromptOnNextFreshSessionPrompt', () => {
  it('returns false when resuming an existing session', () => {
    expect(resolveShouldPrependAppendSystemPromptOnNextFreshSessionPrompt({ startedFreshSession: false })).toBe(false);
  });

  it('returns true when starting a fresh session', () => {
    expect(resolveShouldPrependAppendSystemPromptOnNextFreshSessionPrompt({ startedFreshSession: true })).toBe(true);
  });
});
