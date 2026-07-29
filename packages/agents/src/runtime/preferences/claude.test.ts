import { describe, expect, it } from 'vitest';

import {
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
  CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES,
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE,
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY,
  normalizeClaudeUnifiedTerminalResumeChoice,
  normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy,
} from './claude.js';

describe('Claude unified terminal preferences', () => {
  it('keeps provider-owned enum values and fail-closed defaults canonical', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES).toEqual([
      'ask_every_time',
      'resume_from_summary',
      'resume_full_session',
    ]);
    expect(DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE).toBe('ask_every_time');
    expect(CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES).toEqual([
      'ask_every_time',
      'always_trust_happier_workspaces',
      'always_reject_happier_workspaces',
    ]);
    expect(DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY).toBe('ask_every_time');
  });

  it('accepts only allowlisted persisted preference values', () => {
    expect(normalizeClaudeUnifiedTerminalResumeChoice('resume_full_session')).toBe('resume_full_session');
    expect(normalizeClaudeUnifiedTerminalResumeChoice('2')).toBeNull();
    expect(normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy('always_trust_happier_workspaces'))
      .toBe('always_trust_happier_workspaces');
    expect(normalizeClaudeUnifiedTerminalWorkspaceTrustPolicy(true)).toBeNull();
  });
});
