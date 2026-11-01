import { describe, expect, it } from 'vitest';
import { readClaudeCompactionMetadata } from './compactionMetadata.js';

describe('readClaudeCompactionMetadata', () => {
  it.each([
    { compactMetadata: { trigger: 'auto', preTokens: 250_000, postTokens: 45_000 } },
    { compact_metadata: { trigger: 'auto', pre_tokens: 250_000, post_tokens: 45_000 } },
  ])('preserves only measured native counts', row => {
    expect(readClaudeCompactionMetadata(row)).toEqual({ tokenCountBefore: 250_000, tokenCountAfter: 45_000, tokenCountSource: 'providerReported' });
  });
  it('keeps absent or invalid measurements absent without estimating from usage', () => {
    expect(readClaudeCompactionMetadata({ compactMetadata: { preTokens: 5 }, usage: { output_tokens: 9 } })).toEqual({ tokenCountBefore: 5, tokenCountSource: 'providerReported' });
    expect(readClaudeCompactionMetadata({ compact_metadata: { post_tokens: 9 } })).toEqual({ tokenCountAfter: 9, tokenCountSource: 'providerReported' });
    expect(readClaudeCompactionMetadata({ compact_metadata: { pre_tokens: -1, post_tokens: 2.5 } })).toEqual({});
    expect(readClaudeCompactionMetadata({})).toEqual({});
    expect(readClaudeCompactionMetadata({ compactMetadata: { preTokens: 0, postTokens: 0 } })).toEqual({ tokenCountBefore: 0, tokenCountAfter: 0, tokenCountSource: 'providerReported' });
  });
});
