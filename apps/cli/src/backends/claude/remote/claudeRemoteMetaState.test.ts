import { describe, expect, it } from 'vitest';

import { applyClaudeRemoteMetaState, DEFAULT_CLAUDE_REMOTE_META_STATE } from './claudeRemoteMetaState';

describe('applyClaudeRemoteMetaState', () => {
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

  it('ignores invalid settingSources values and keeps previous value', () => {
    const prev = { ...DEFAULT_CLAUDE_REMOTE_META_STATE, claudeRemoteSettingSources: 'project' as const };
    const next = applyClaudeRemoteMetaState(prev, { claudeRemoteSettingSources: 'workspace' });
    expect(next.claudeRemoteSettingSources).toBe('project');
  });

  it('applies supported boolean toggles when provided', () => {
    const next = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, {
      claudeRemoteAgentSdkEnabled: true,
      claudeRemoteIncludePartialMessages: true,
      claudeRemoteEnableFileCheckpointing: true,
      claudeRemoteDisableTodos: true,
      claudeRemoteStrictMcpServerConfig: true,
    });

    expect(next).toMatchObject({
      claudeRemoteAgentSdkEnabled: true,
      claudeRemoteIncludePartialMessages: true,
      claudeRemoteEnableFileCheckpointing: true,
      claudeRemoteDisableTodos: true,
      claudeRemoteStrictMcpServerConfig: true,
    });
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

  it('returns a frozen result object', () => {
    const next = applyClaudeRemoteMetaState(DEFAULT_CLAUDE_REMOTE_META_STATE, {
      claudeRemoteDisableTodos: true,
    });
    expect(Object.isFrozen(next)).toBe(true);
  });
});
