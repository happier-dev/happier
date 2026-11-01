import { describe, expect, it } from 'vitest';

import { applyClaudeRemoteMetaState, DEFAULT_CLAUDE_REMOTE_META_STATE } from './claudeRemoteMetaState';

describe('applyClaudeRemoteMetaState', () => {
  it('defaults idle reclamation off, accepts opt-in, and rejects invalid durations', () => {
    expect(DEFAULT_CLAUDE_REMOTE_META_STATE).toMatchObject({
      claudeRemoteIdleReclaimEnabled: false, claudeRemoteIdleReclaimTimeoutMinutes: 30,
    });
    const enabled = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, {
      claudeRemoteIdleReclaimEnabled: true, claudeRemoteIdleReclaimTimeoutMinutes: 45,
    });
    expect(enabled).toMatchObject({ claudeRemoteIdleReclaimEnabled: true, claudeRemoteIdleReclaimTimeoutMinutes: 45 });
    expect(applyClaudeRemoteMetaState(enabled, {})).toMatchObject({ claudeRemoteIdleReclaimEnabled: true });
    for (const invalid of [0, -1, 1.5, '30', Math.floor(2_147_483_647 / 60_000) + 1]) {
      expect(applyClaudeRemoteMetaState(enabled, {
        claudeRemoteIdleReclaimEnabled: 'false', claudeRemoteIdleReclaimTimeoutMinutes: invalid,
      })).toMatchObject({ claudeRemoteIdleReclaimEnabled: true, claudeRemoteIdleReclaimTimeoutMinutes: 45 });
    }
    expect(applyClaudeRemoteMetaState(enabled, { claudeRemoteIdleReclaimEnabled: false }))
      .toMatchObject({ claudeRemoteIdleReclaimEnabled: false });
  });

  it('accepts explicit Happier attribution and preserves it when old messages omit the field', () => {
    const enabled = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, { claudeCodeIncludeInNativeHistory: true });
    expect(enabled).toMatchObject({ claudeCodeIncludeInNativeHistory: true });
    expect(applyClaudeRemoteMetaState(enabled, {})).toMatchObject({ claudeCodeIncludeInNativeHistory: true });
    expect(applyClaudeRemoteMetaState(enabled, { claudeCodeIncludeInNativeHistory: 'false' })).toMatchObject({ claudeCodeIncludeInNativeHistory: true });
    expect(applyClaudeRemoteMetaState(enabled, { claudeCodeIncludeInNativeHistory: false })).toMatchObject({ claudeCodeIncludeInNativeHistory: false });
  });

  it('defaults unified terminal metadata to disabled auto host', () => {
    expect((DEFAULT_CLAUDE_REMOTE_META_STATE as any).claudeUnifiedTerminalEnabled).toBe(false);
    expect((DEFAULT_CLAUDE_REMOTE_META_STATE as any).claudeUnifiedTerminalHost).toBe('auto');
    expect((DEFAULT_CLAUDE_REMOTE_META_STATE as any).claudeUnifiedTerminalResumeChoice).toBe('ask_every_time');
  });

  it('defaults claudeRemoteSettingSourcesV2 to user+project+local (matches Claude Code default behavior)', () => {
    expect((DEFAULT_CLAUDE_REMOTE_META_STATE as any).claudeRemoteSettingSourcesV2).toEqual(['user', 'project', 'local']);
  });

  it('accepts null for claudeRemoteMaxThinkingTokens', () => {
    const next = applyClaudeRemoteMetaState(
      { ...DEFAULT_CLAUDE_REMOTE_META_STATE, claudeRemoteMaxThinkingTokens: 123 },
      { claudeRemoteMaxThinkingTokens: null },
    );
    expect(next.claudeRemoteMaxThinkingTokens).toBeNull();
  });

  it('rejects negative claudeRemoteMaxThinkingTokens', () => {
    const next = applyClaudeRemoteMetaState(
      { ...DEFAULT_CLAUDE_REMOTE_META_STATE, claudeRemoteMaxThinkingTokens: 123 },
      { claudeRemoteMaxThinkingTokens: -1 },
    );
    expect(next.claudeRemoteMaxThinkingTokens).toBe(123);
  });

  it('rejects non-integer claudeRemoteMaxThinkingTokens', () => {
    const next = applyClaudeRemoteMetaState(
      { ...DEFAULT_CLAUDE_REMOTE_META_STATE, claudeRemoteMaxThinkingTokens: 123 },
      { claudeRemoteMaxThinkingTokens: 1.5 },
    );
    expect(next.claudeRemoteMaxThinkingTokens).toBe(123);
  });

  it('accepts non-negative integers for claudeRemoteMaxThinkingTokens', () => {
    const next = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, { claudeRemoteMaxThinkingTokens: 0 });
    expect(next.claudeRemoteMaxThinkingTokens).toBe(0);

    const next2 = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, { claudeRemoteMaxThinkingTokens: 100 });
    expect(next2.claudeRemoteMaxThinkingTokens).toBe(100);
  });

  it('ignores invalid legacy settingSources values and keeps previous value', () => {
    const prev = { ...DEFAULT_CLAUDE_REMOTE_META_STATE, claudeRemoteSettingSources: 'project' as const } as any;
    const next = applyClaudeRemoteMetaState(prev, { claudeRemoteSettingSources: 'workspace' });
    expect((next as any).claudeRemoteSettingSources).toBe('project');
  });

  it('accepts claudeRemoteSettingSourcesV2 arrays when provided', () => {
    const next = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE as any, {
      claudeRemoteSettingSourcesV2: ['local', 'user', 'project', 'local', 'bogus'],
    });
    // Normalized to stable order with invalid/dupes dropped.
    expect((next as any).claudeRemoteSettingSourcesV2).toEqual(['user', 'project', 'local']);
  });

  it('applies supported boolean toggles when provided', () => {
    const next = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, {
      claudeRemoteAgentSdkEnabled: true,
      claudeUnifiedTerminalEnabled: true,
      claudeLocalPermissionBridgeEnabled: true,
      claudeLocalPermissionBridgeWaitIndefinitely: true,
      claudeRemoteEnableFileCheckpointing: true,
      claudeRemoteDisableTodos: true,
      claudeRemoteStrictMcpServerConfig: true,
      claudeCodeExperimentalAgentTeamsEnabled: true,
      claudeRemoteDebugEnabled: true,
      claudeRemoteVerboseEnabled: true,
    });

    expect(next).toMatchObject({
      claudeRemoteAgentSdkEnabled: true,
      claudeUnifiedTerminalEnabled: true,
      claudeLocalPermissionBridgeEnabled: true,
      claudeLocalPermissionBridgeWaitIndefinitely: true,
      claudeRemoteEnableFileCheckpointing: true,
      claudeRemoteDisableTodos: true,
      claudeRemoteStrictMcpServerConfig: true,
      claudeCodeExperimentalAgentTeamsEnabled: true,
      claudeRemoteDebugEnabled: true,
      claudeRemoteVerboseEnabled: true,
    });
  });

  it('retains independent unified response locations through metadata updates', () => {
    const next = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, {
      claudeUnifiedTerminalQuestionResponseLocation: 'terminal_only',
      claudeUnifiedTerminalPermissionResponseLocation: 'app_only',
    });
    expect(next).toMatchObject({
      claudeUnifiedTerminalQuestionResponseLocation: 'terminal_only',
      claudeUnifiedTerminalPermissionResponseLocation: 'app_only',
    });
    expect(applyClaudeRemoteMetaState(next, { claudeUnifiedTerminalQuestionResponseLocation: 'invalid' }))
      .toMatchObject({ claudeUnifiedTerminalQuestionResponseLocation: 'terminal_only' });
  });

  it('applies valid unified terminal host values only', () => {
    const tmux = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, {
      claudeUnifiedTerminalHost: 'tmux',
    });
    expect((tmux as any).claudeUnifiedTerminalHost).toBe('tmux');

    const zellij = applyClaudeRemoteMetaState(tmux, {
      claudeUnifiedTerminalHost: 'zellij',
    });
    expect((zellij as any).claudeUnifiedTerminalHost).toBe('zellij');

    const next = applyClaudeRemoteMetaState(zellij, {
      claudeUnifiedTerminalHost: 'screen',
    });
    expect((next as any).claudeUnifiedTerminalHost).toBe('zellij');
  });

  it('applies valid unified terminal resume-choice values only', () => {
    const summary = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, {
      claudeUnifiedTerminalResumeChoice: 'resume_from_summary',
    });
    expect((summary as any).claudeUnifiedTerminalResumeChoice).toBe('resume_from_summary');

    const full = applyClaudeRemoteMetaState(summary, {
      claudeUnifiedTerminalResumeChoice: 'resume_full_session',
    });
    expect((full as any).claudeUnifiedTerminalResumeChoice).toBe('resume_full_session');

    const ask = applyClaudeRemoteMetaState(full, {
      claudeUnifiedTerminalResumeChoice: 'ask_every_time',
    });
    expect((ask as any).claudeUnifiedTerminalResumeChoice).toBe('ask_every_time');

    const next = applyClaudeRemoteMetaState(ask, {
      claudeUnifiedTerminalResumeChoice: 'resume_partial_session',
    });
    expect((next as any).claudeUnifiedTerminalResumeChoice).toBe('ask_every_time');
  });

  it('normalizes claudeRemoteDebugCategories arrays when provided', () => {
    const next = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE as any, {
      claudeRemoteDebugCategories: ['mcp', 'api', 'api', 'bogus', 'file'],
    });
    expect((next as any).claudeRemoteDebugCategories).toEqual(['api', 'mcp', 'file']);
  });

  it('applies advanced options JSON only when the value is a string', () => {
    const base = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, {
      claudeRemoteAdvancedOptionsJson: '{"plugins":[]}',
    });
    expect(base.claudeRemoteAdvancedOptionsJson).toBe('{"plugins":[]}');

    const next = applyClaudeRemoteMetaState(base, {
      claudeRemoteAdvancedOptionsJson: { plugins: [] },
    });
    expect(next.claudeRemoteAdvancedOptionsJson).toBe('{"plugins":[]}');
  });

  it('applies positive integers for claudeLocalPermissionBridgeTimeoutSeconds', () => {
    const next = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, {
      claudeLocalPermissionBridgeTimeoutSeconds: 123,
    });
    expect((next as any).claudeLocalPermissionBridgeTimeoutSeconds).toBe(123);

    const next2 = applyClaudeRemoteMetaState(next, {
      claudeLocalPermissionBridgeTimeoutSeconds: 0,
    });
    expect((next2 as any).claudeLocalPermissionBridgeTimeoutSeconds).toBe(123);
  });

  it('returns a frozen result object', () => {
    const next = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, {
      claudeRemoteDisableTodos: true,
    });
    expect(Object.isFrozen(next)).toBe(true);
  });
});
