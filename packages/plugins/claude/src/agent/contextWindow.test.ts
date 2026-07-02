import { describe, expect, it } from 'vitest';

import {
    bumpClaudeContextWindowTokensForObservedUsage,
    CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
    CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
    isClaude1mAlwaysOnModelId,
    isClaude1mContextOptInModelId,
    isClaude1mModelId,
    resolveClaudeContextWindowTokensForModelId,
    stripClaude1mSuffix,
    toClaude1mModelId,
} from './contextWindow.js';

describe('Claude 1M model-id variant facts', () => {
    it('detects the explicit [1m] variant suffix', () => {
        expect(isClaude1mModelId('claude-sonnet-4-6[1m]')).toBe(true);
        expect(isClaude1mModelId('claude-sonnet-4-6')).toBe(false);
        expect(isClaude1mModelId(undefined)).toBe(false);
    });

    it('strips and appends the suffix idempotently', () => {
        expect(stripClaude1mSuffix('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6');
        expect(stripClaude1mSuffix('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
        expect(toClaude1mModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6[1m]');
        expect(toClaude1mModelId('claude-sonnet-4-6[1m]')).toBe('claude-sonnet-4-6[1m]');
    });

    it('classifies always-1M vs opt-in 1M models, [1m]-tolerant', () => {
        expect(isClaude1mAlwaysOnModelId('claude-fable-5')).toBe(true);
        expect(isClaude1mAlwaysOnModelId('claude-opus-4-8')).toBe(true);
        expect(isClaude1mAlwaysOnModelId('claude-opus-4-7')).toBe(true);
        expect(isClaude1mAlwaysOnModelId('claude-sonnet-4-6')).toBe(false);
        expect(isClaude1mContextOptInModelId('claude-sonnet-4-6')).toBe(true);
        expect(isClaude1mContextOptInModelId('claude-opus-4-6')).toBe(true);
        expect(isClaude1mContextOptInModelId('claude-fable-5')).toBe(false);
        expect(isClaude1mContextOptInModelId('claude-haiku-4-5')).toBe(false);
    });
});

describe('resolveClaudeContextWindowTokensForModelId', () => {
    it('resolves 1M for any explicit [1m] variant id', () => {
        expect(resolveClaudeContextWindowTokensForModelId('claude-sonnet-4-6[1m]'))
            .toBe(CLAUDE_1M_CONTEXT_WINDOW_TOKENS);
    });

    it('resolves 1M for always-1M models even with a BASE id (JSONL reports base ids)', () => {
        expect(resolveClaudeContextWindowTokensForModelId('claude-fable-5'))
            .toBe(CLAUDE_1M_CONTEXT_WINDOW_TOKENS);
    });

    it('resolves null otherwise so callers fall back to catalog facts or the default', () => {
        expect(resolveClaudeContextWindowTokensForModelId('claude-sonnet-4-6')).toBeNull();
        expect(resolveClaudeContextWindowTokensForModelId('claude-haiku-4-5')).toBeNull();
        expect(resolveClaudeContextWindowTokensForModelId('')).toBeNull();
    });
});

describe('bumpClaudeContextWindowTokensForObservedUsage', () => {
    it('keeps the assumed window when observed usage fits', () => {
        expect(bumpClaudeContextWindowTokensForObservedUsage({
            contextWindowTokens: CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
            observedUsedTokens: 150_000,
        })).toBe(CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS);
    });

    it('bumps to the smallest known window that fits the observation (incident 733k/200k)', () => {
        expect(bumpClaudeContextWindowTokensForObservedUsage({
            contextWindowTokens: CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
            observedUsedTokens: 733_000,
        })).toBe(CLAUDE_1M_CONTEXT_WINDOW_TOKENS);
    });

    it('trusts the observation beyond every known window so usage never exceeds 100%', () => {
        expect(bumpClaudeContextWindowTokensForObservedUsage({
            contextWindowTokens: CLAUDE_1M_CONTEXT_WINDOW_TOKENS,
            observedUsedTokens: 1_200_000,
        })).toBe(1_200_000);
    });

    it('ignores non-finite or non-positive observations', () => {
        expect(bumpClaudeContextWindowTokensForObservedUsage({
            contextWindowTokens: CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS,
            observedUsedTokens: Number.NaN,
        })).toBe(CLAUDE_DEFAULT_CONTEXT_WINDOW_TOKENS);
    });
});
