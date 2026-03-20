import { describe, expect, it } from 'vitest';

import { resolveInitialClaudeSystemPromptText } from './resolveInitialClaudeSystemPromptText';

describe('resolveInitialClaudeSystemPromptText', () => {
  it('returns the default system prompt text for new sessions', () => {
    expect(
      resolveInitialClaudeSystemPromptText({
        existingSessionId: null,
        defaultSystemPromptText: 'APPEND',
      }),
    ).toBe('APPEND');
  });

  it('omits the default system prompt text when resuming an existing session', () => {
    expect(
      resolveInitialClaudeSystemPromptText({
        existingSessionId: 'session-123',
        defaultSystemPromptText: 'APPEND',
      }),
    ).toBeUndefined();
  });

  it('trims blank default system prompt text to undefined', () => {
    expect(
      resolveInitialClaudeSystemPromptText({
        existingSessionId: null,
        defaultSystemPromptText: '   ',
      }),
    ).toBeUndefined();
  });
});
