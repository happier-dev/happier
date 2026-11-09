import { describe, expect, it } from 'vitest';

import { resolveClaudeRetainedAppendSystemPromptText, resolveInitialClaudeSystemPromptText } from './resolveInitialClaudeSystemPromptText';

const withRole = { sessionRoleV1: { v: 1, role: 'reviewer', instructions: 'REVIEW SNAPSHOT', assignmentId: 'a-1', assignedAt: 1 } };

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

  it('keeps only the retained role block when resuming an existing session, never the default base', () => {
    const resumed = resolveInitialClaudeSystemPromptText({
      existingSessionId: 'session-123',
      defaultSystemPromptText: 'APPEND',
      sessionMetadata: withRole,
    });
    expect(resumed).toContain('Current role assignment: Reviewer');
    expect(resumed).toContain('REVIEW SNAPSHOT');
    expect(resumed).not.toContain('APPEND');
  });

  it('carries the retained role through a message reset (null) or a custom append, and adds nothing without a role', () => {
    const reset = resolveClaudeRetainedAppendSystemPromptText({ base: null, sessionMetadata: withRole });
    expect(reset?.startsWith('Current role assignment: Reviewer')).toBe(true);
    const custom = resolveClaudeRetainedAppendSystemPromptText({ base: 'CUSTOM', sessionMetadata: withRole });
    expect(custom?.startsWith('CUSTOM')).toBe(true);
    expect(custom?.split('Current role assignment: Reviewer').length).toBe(2);
    expect(resolveClaudeRetainedAppendSystemPromptText({ base: null, sessionMetadata: {} })).toBeUndefined();
    expect(resolveClaudeRetainedAppendSystemPromptText({ base: 'CUSTOM', sessionMetadata: {} })).toBe('CUSTOM');
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
