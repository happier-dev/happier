import { describe, expect, it } from 'vitest';

import {
  CLAUDE_UNIFIED_TERMINAL_RESUME_CHOICES,
  normalizeClaudeUnifiedTerminalResumeChoice,
  parseClaudeRemoteAdvancedOptionsJson,
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

describe('parseClaudeRemoteAdvancedOptionsJson', () => {
  it('retains only the released Agent SDK advanced-option allowlist', () => {
    expect(parseClaudeRemoteAdvancedOptionsJson(JSON.stringify({
      plugins: [{ type: 'local', path: '/tmp/plugin' }],
      betas: ['beta-a'],
      maxBudgetUsd: 3.5,
      sandbox: { enabled: true },
      additionalDirectories: ['/tmp/extra'],
      permissionPromptToolName: 'stdio',
      tools: ['Read', 'Edit'],
      systemPrompt: 'Be concise',
      debug: true,
      debugFile: '/tmp/claude-debug.log',
      stderr: 'not-a-function-and-therefore-not-reachable-from-JSON',
      maxTurns: 999,
      env: { SHOULD_NOT: 'escape' },
    }))).toEqual({
      plugins: [{ type: 'local', path: '/tmp/plugin' }],
      betas: ['beta-a'],
      maxBudgetUsd: 3.5,
      sandbox: { enabled: true },
      additionalDirectories: ['/tmp/extra'],
      permissionPromptToolName: 'stdio',
      tools: ['Read', 'Edit'],
      systemPrompt: 'Be concise',
      debug: true,
      debugFile: '/tmp/claude-debug.log',
    });
  });

  it('fails closed for malformed, non-object, and oversized values', () => {
    expect(parseClaudeRemoteAdvancedOptionsJson('{ nope')).toEqual({});
    expect(parseClaudeRemoteAdvancedOptionsJson('[]')).toEqual({});
    expect(parseClaudeRemoteAdvancedOptionsJson(`{"value":"${'x'.repeat(16_384)}"}`)).toEqual({});
  });
});
