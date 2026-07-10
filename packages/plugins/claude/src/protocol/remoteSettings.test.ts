import { describe, expect, it } from 'vitest';

import {
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
  normalizeClaudeUnifiedTerminalResumeChoice,
} from './remoteSettings.js';

describe('normalizeClaudeUnifiedTerminalResumeChoice', () => {
  it('accepts only canonical Claude unified terminal resume choices', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES).toEqual([
      'ask_every_time',
      'resume_from_summary',
      'resume_full_session',
    ]);

    expect(normalizeClaudeUnifiedTerminalResumeChoice('ask_every_time')).toBe('ask_every_time');
    expect(normalizeClaudeUnifiedTerminalResumeChoice('resume_from_summary')).toBe('resume_from_summary');
    expect(normalizeClaudeUnifiedTerminalResumeChoice('resume_full_session')).toBe('resume_full_session');
    expect(normalizeClaudeUnifiedTerminalResumeChoice('summary')).toBeNull();
    expect(normalizeClaudeUnifiedTerminalResumeChoice(null)).toBeNull();
  });
});
