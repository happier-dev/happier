import { describe, expect, it } from 'vitest';

import {
  CLAUDE_AGENT_SETTINGS_CONTRIBUTION,
  CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS,
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
} from './definition.js';

describe('CLAUDE_AGENT_SETTINGS_CONTRIBUTION', () => {
  it('defines the unified terminal resume-choice setting in the unified terminal section', () => {
    expect(CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES).toEqual([
      'ask_every_time',
      'resume_from_summary',
      'resume_full_session',
    ]);

    const field = CLAUDE_AGENT_SETTINGS_CONTRIBUTION.fields.find(
      (entry) => entry.id === 'claudeUnifiedTerminalResumeChoice',
    );
    expect(field).toEqual(expect.objectContaining({
      id: 'claudeUnifiedTerminalResumeChoice',
      schema: { kind: 'enum', values: ['ask_every_time', 'resume_from_summary', 'resume_full_session'] },
      default: 'ask_every_time',
    }));
    expect(CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS.claudeUnifiedTerminalResumeChoice).toBe('ask_every_time');

    const section = CLAUDE_AGENT_SETTINGS_CONTRIBUTION.ui.sections.find(
      (entry) => entry.id === 'claudeUnifiedTerminal',
    );
    expect(section?.fields).toEqual([
      'claudeUnifiedTerminalEnabled',
      'claudeUnifiedTerminalHost',
      'claudeUnifiedTerminalResumeChoice',
    ]);
  });
});
