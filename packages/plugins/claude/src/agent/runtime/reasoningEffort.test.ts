import { describe, expect, it } from 'vitest';

import {
  buildClaudeEffortCliArgs,
  isClaudeUltracodeSupportedModelId,
  resolveClaudeDefaultEffortLevelForModelId,
  resolveClaudeEffortLevelsForModelId,
} from './reasoningEffort.js';

describe('buildClaudeEffortCliArgs', () => {
  it('treats Fable 5 high as the default effort', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('treats Opus 4.8 high as the default effort', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-8', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-8', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('treats the generic opus alias as Opus 4.8 for default effort resolution', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'opus', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'opus', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('keeps Opus 4.7 behavior where high still requires an explicit override', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-7', effort: 'high' })).toEqual(['--effort', 'high']);
  });
});

describe('[1m] extended-context model-id lookups', () => {
  it('resolves effort levels for a [1m] variant id through the direct lookup', () => {
    expect(resolveClaudeEffortLevelsForModelId('claude-sonnet-4-6[1m]'))
      .toEqual(resolveClaudeEffortLevelsForModelId('claude-sonnet-4-6'));
    expect(resolveClaudeEffortLevelsForModelId('claude-fable-5[1m]'))
      .toEqual(resolveClaudeEffortLevelsForModelId('claude-fable-5'));
  });

  it('resolves the default effort level for a [1m] variant id', () => {
    expect(resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-7[1m]')).toBe('xhigh');
    expect(resolveClaudeDefaultEffortLevelForModelId('claude-sonnet-4-6[1m]')).toBe('high');
  });

  it('keeps CLI effort args lookup-only (the sent model id is never mutated)', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5[1m]', effort: 'xhigh' }))
      .toEqual(['--effort', 'xhigh']);
  });
});

describe('isClaudeUltracodeSupportedModelId', () => {
  it('allows ultracode only on xhigh-capable models, [1m]-tolerant', () => {
    expect(isClaudeUltracodeSupportedModelId('claude-fable-5')).toBe(true);
    expect(isClaudeUltracodeSupportedModelId('claude-fable-5[1m]')).toBe(true);
    expect(isClaudeUltracodeSupportedModelId('claude-opus-4-8')).toBe(true);
    expect(isClaudeUltracodeSupportedModelId('claude-opus-4-7')).toBe(true);
    expect(isClaudeUltracodeSupportedModelId('opus')).toBe(true);
  });

  it('rejects ultracode on models without xhigh', () => {
    expect(isClaudeUltracodeSupportedModelId('claude-sonnet-4-6')).toBe(false);
    expect(isClaudeUltracodeSupportedModelId('claude-opus-4-6')).toBe(false);
    expect(isClaudeUltracodeSupportedModelId('claude-haiku-4-5')).toBe(false);
    expect(isClaudeUltracodeSupportedModelId('')).toBe(false);
    expect(isClaudeUltracodeSupportedModelId(null)).toBe(false);
  });
});
