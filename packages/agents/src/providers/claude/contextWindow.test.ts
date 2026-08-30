import { describe, expect, it } from 'vitest';

import {
  CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
  CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
  bumpClaudeContextWindowTokensForObservedUsage,
  isClaude1mAlwaysOnModelId,
  isClaude1mContextOptInModelId,
  isClaude1mContextSupportedModelId,
  isClaude1mModelId,
  resolveClaudeContextWindowTokensForModelId,
  stripClaude1mSuffix,
  toClaude1mModelId,
} from './contextWindow.js';

describe('claude 1m context facts', () => {
  it('marks 1M-capable models as supported (incl. [1m] variants)', () => {
    expect(isClaude1mContextSupportedModelId('claude-fable-5')).toBe(true);
    expect(isClaude1mContextSupportedModelId('claude-opus-5')).toBe(true);
    expect(isClaude1mContextSupportedModelId('claude-sonnet-5')).toBe(true);
    expect(isClaude1mContextSupportedModelId('claude-opus-4-8')).toBe(true);
    expect(isClaude1mContextSupportedModelId('claude-opus-4-7')).toBe(true);
    expect(isClaude1mContextSupportedModelId('claude-opus-4-6')).toBe(true);
    expect(isClaude1mContextSupportedModelId('claude-sonnet-4-6')).toBe(true);
    expect(isClaude1mContextSupportedModelId('claude-sonnet-4-6[1m]')).toBe(true);
  });

  it('marks non-1M models as unsupported', () => {
    expect(isClaude1mContextSupportedModelId('claude-haiku-4-5')).toBe(false);
    expect(isClaude1mContextSupportedModelId('claude-opus-4-5')).toBe(false);
    expect(isClaude1mContextSupportedModelId('claude-sonnet-4-5')).toBe(false);
    expect(isClaude1mContextSupportedModelId(undefined)).toBe(false);
  });

  it('marks current always-1M models as having no opt-in toggle', () => {
    expect(isClaude1mAlwaysOnModelId('claude-fable-5')).toBe(true);
    expect(isClaude1mAlwaysOnModelId('claude-opus-5')).toBe(true);
    expect(isClaude1mAlwaysOnModelId('claude-sonnet-5')).toBe(true);
    expect(isClaude1mAlwaysOnModelId('claude-opus-4-8')).toBe(true);
    expect(isClaude1mAlwaysOnModelId('claude-opus-4-7')).toBe(true);
    expect(isClaude1mAlwaysOnModelId('claude-opus-4-6')).toBe(false);
    expect(isClaude1mAlwaysOnModelId('claude-sonnet-4-6')).toBe(false);
  });

  it('marks only Sonnet 4.6 and Opus 4.6 as 1M opt-in models', () => {
    expect(isClaude1mContextOptInModelId('claude-sonnet-4-6')).toBe(true);
    expect(isClaude1mContextOptInModelId('claude-opus-4-6')).toBe(true);
    expect(isClaude1mContextOptInModelId('claude-fable-5')).toBe(false);
    expect(isClaude1mContextOptInModelId('claude-opus-5')).toBe(false);
    expect(isClaude1mContextOptInModelId('claude-sonnet-5')).toBe(false);
    expect(isClaude1mContextOptInModelId('claude-opus-4-8')).toBe(false);
    expect(isClaude1mContextOptInModelId('claude-haiku-4-5')).toBe(false);
  });

  it('adds and strips the [1m] suffix without mutating unrelated ids', () => {
    expect(toClaude1mModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6[1m]');
    expect(toClaude1mModelId('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6[1m]');
    expect(stripClaude1mSuffix('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6');
    expect(stripClaude1mSuffix('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(stripClaude1mSuffix(' claude-opus-4-6[1M] ')).toBe('claude-opus-4-6');
    expect(isClaude1mModelId('claude-sonnet-4-6[1m]')).toBe(true);
    expect(isClaude1mModelId('claude-sonnet-4-6')).toBe(false);
  });
});

// Lane U8 additions below (context-window resolution + observed-usage evidence bump).
describe('resolveClaudeContextWindowTokensForModelId', () => {
  it('resolves 1M for any explicit [1m] model override', () => {
    expect(resolveClaudeContextWindowTokensForModelId('claude-sonnet-4-6[1m]')).toBe(1_000_000);
    expect(resolveClaudeContextWindowTokensForModelId('claude-opus-4-6[1m]')).toBe(1_000_000);
    expect(resolveClaudeContextWindowTokensForModelId(' Claude-Sonnet-4-6[1M] ')).toBe(1_000_000);
  });

  it('resolves 1M for always-1M models even with a BASE id (Unified hook/JSONL model is the base id)', () => {
    expect(resolveClaudeContextWindowTokensForModelId('claude-fable-5')).toBe(1_000_000);
    expect(resolveClaudeContextWindowTokensForModelId('claude-opus-5')).toBe(1_000_000);
    expect(resolveClaudeContextWindowTokensForModelId('claude-sonnet-5')).toBe(1_000_000);
    expect(resolveClaudeContextWindowTokensForModelId('claude-opus-4-8')).toBe(1_000_000);
    expect(resolveClaudeContextWindowTokensForModelId('claude-opus-4-7')).toBe(1_000_000);
  });

  it('returns null for opt-in models on the base id and for unknown/empty ids', () => {
    expect(resolveClaudeContextWindowTokensForModelId('claude-sonnet-4-6')).toBeNull();
    expect(resolveClaudeContextWindowTokensForModelId('claude-opus-4-6')).toBeNull();
    expect(resolveClaudeContextWindowTokensForModelId('claude-haiku-4-5')).toBeNull();
    expect(resolveClaudeContextWindowTokensForModelId('')).toBeNull();
    expect(resolveClaudeContextWindowTokensForModelId(undefined)).toBeNull();
  });
});

describe('bumpClaudeContextWindowTokensForObservedUsage', () => {
  it('keeps the assumed window when observed usage fits', () => {
    expect(bumpClaudeContextWindowTokensForObservedUsage({
      contextWindowTokens: CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
      observedUsedTokens: 150_000,
    })).toBe(CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it('bumps 200k to 1M when observed usage exceeds the assumed window (incident: 733k > 200k)', () => {
    expect(bumpClaudeContextWindowTokensForObservedUsage({
      contextWindowTokens: CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
      observedUsedTokens: 733_000,
    })).toBe(CLAUDE_1M_CONTEXT_WINDOW_TOKENS);
  });

  it('falls back to the observed usage when it exceeds every known window', () => {
    expect(bumpClaudeContextWindowTokensForObservedUsage({
      contextWindowTokens: CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
      observedUsedTokens: 1_200_000,
    })).toBe(1_200_000);
  });

  it('ignores invalid observed usage', () => {
    expect(bumpClaudeContextWindowTokensForObservedUsage({
      contextWindowTokens: CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
      observedUsedTokens: Number.NaN,
    })).toBe(CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(bumpClaudeContextWindowTokensForObservedUsage({
      contextWindowTokens: CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
      observedUsedTokens: -5,
    })).toBe(CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS);
  });
});
