import { describe, expect, it } from 'vitest';

import {
  CLAUDE_AGENT_SETTINGS_CONTRIBUTION,
  CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS,
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
  CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES,
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE,
  DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY,
} from './definition.js';

describe('CLAUDE_AGENT_SETTINGS_CONTRIBUTION', () => {
  it('preserves released Agent Teams and advanced Agent SDK account settings in the canonical UI contribution', () => {
    const agentTeamsField = CLAUDE_AGENT_SETTINGS_CONTRIBUTION.fields.find(
      (entry) => entry.id === 'claudeCodeExperimentalAgentTeamsEnabled',
    );
    expect(agentTeamsField).toEqual(expect.objectContaining({
      id: 'claudeCodeExperimentalAgentTeamsEnabled',
      schema: expect.objectContaining({ type: 'boolean' }),
      default: false,
      presentation: { control: 'switch' },
    }));

    const advancedOptionsField = CLAUDE_AGENT_SETTINGS_CONTRIBUTION.fields.find(
      (entry) => entry.id === 'claudeRemoteAdvancedOptionsJson',
    );
    expect(advancedOptionsField).toEqual(expect.objectContaining({
      id: 'claudeRemoteAdvancedOptionsJson',
      schema: expect.objectContaining({
        type: 'string',
        maxLength: 16_384,
      }),
      default: '',
      presentation: { control: 'textarea' },
    }));

    expect(CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS).toMatchObject({
      claudeCodeExperimentalAgentTeamsEnabled: false,
      claudeRemoteAdvancedOptionsJson: '',
    });
    expect(CLAUDE_AGENT_SETTINGS_CONTRIBUTION.presentation.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'claude-code-experiments',
          fields: ['claudeCodeExperimentalAgentTeamsEnabled'],
        }),
        expect.objectContaining({
          id: 'claude-remote-sdk',
          fields: expect.arrayContaining(['claudeRemoteAdvancedOptionsJson']),
        }),
      ]),
    );
  });

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
      schema: expect.objectContaining({
        type: 'string',
        enum: ['ask_every_time', 'resume_from_summary', 'resume_full_session'],
      }),
      default: 'ask_every_time',
    }));
    expect(CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS.claudeUnifiedTerminalResumeChoice).toBe('ask_every_time');
    expect(DEFAULT_CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICE).toBe('ask_every_time');
    expect(CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICIES).toEqual([
      'ask_every_time',
      'always_trust_happier_workspaces',
      'always_reject_happier_workspaces',
    ]);
    expect(CLAUDE_REMOTE_AGENT_SETTINGS_DEFAULTS.claudeUnifiedTerminalWorkspaceTrust).toBe('ask_every_time');
    expect(DEFAULT_CLAUDE_UNIFIED_TERMINAL_WORKSPACE_TRUST_POLICY).toBe('ask_every_time');

    const section = CLAUDE_AGENT_SETTINGS_CONTRIBUTION.presentation.sections.find(
      (entry) => entry.id === 'claude-unified-terminal',
    );
    expect(section?.fields).toEqual([
      'claudeUnifiedTerminalEnabled',
      'claudeUnifiedTerminalHost',
      'claudeUnifiedTerminalResumeChoice',
      'claudeUnifiedTerminalWorkspaceTrust',
    ]);
  });
});
