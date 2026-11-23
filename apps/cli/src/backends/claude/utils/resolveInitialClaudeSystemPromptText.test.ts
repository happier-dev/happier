import { describe, expect, it } from 'vitest';

import { resolveInitialClaudeSystemPromptText } from './resolveInitialClaudeSystemPromptText';

describe('resolveInitialClaudeSystemPromptText', () => {
  it.each(['agentSdk', 'legacy'] as const)('returns the default system prompt text for new %s sessions', (runtimeModeKind) => {
    expect(
      resolveInitialClaudeSystemPromptText({
        runtimeModeKind,
        existingSessionId: null,
        defaultSystemPromptText: 'APPEND',
      }),
    ).toBe('APPEND');
  });

  it('omits the default system prompt text when resuming an existing session', () => {
    expect(
      resolveInitialClaudeSystemPromptText({
        runtimeModeKind: 'agentSdk',
        existingSessionId: 'session-123',
        defaultSystemPromptText: 'APPEND',
      }),
    ).toBeUndefined();
  });

  it('trims blank default system prompt text to undefined', () => {
    expect(
      resolveInitialClaudeSystemPromptText({
        runtimeModeKind: 'agentSdk',
        existingSessionId: null,
        defaultSystemPromptText: '   ',
      }),
    ).toBeUndefined();
  });
});
