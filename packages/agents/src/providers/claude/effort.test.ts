import { describe, expect, it } from 'vitest';

import {
  isClaudeEffortMaxSupportedModelId,
  isClaudeEffortSupportedModelId,
  isClaudeUltracodeSupportedModelId,
  resolveClaudeDefaultEffortLevelForModelId,
  resolveClaudeEffortLevelsForModelId,
} from './effort.js';

describe('claude effort support', () => {
  it('marks Fable 5 as effort+max capable with xhigh support and high default effort', () => {
    expect(isClaudeEffortSupportedModelId('claude-fable-5')).toBe(true);
    expect(isClaudeEffortMaxSupportedModelId('claude-fable-5')).toBe(true);
    expect(resolveClaudeEffortLevelsForModelId('claude-fable-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveClaudeDefaultEffortLevelForModelId('claude-fable-5')).toBe('high');
  });

  it('marks Opus 5 as effort+max capable with xhigh support and high default effort', () => {
    expect(isClaudeEffortSupportedModelId('claude-opus-5')).toBe(true);
    expect(isClaudeEffortMaxSupportedModelId('claude-opus-5')).toBe(true);
    expect(resolveClaudeEffortLevelsForModelId('claude-opus-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveClaudeDefaultEffortLevelForModelId('claude-opus-5')).toBe('high');
  });

  it('marks Sonnet 5 as effort+max capable with xhigh support and high default effort', () => {
    expect(isClaudeEffortSupportedModelId('claude-sonnet-5')).toBe(true);
    expect(isClaudeEffortMaxSupportedModelId('claude-sonnet-5')).toBe(true);
    expect(resolveClaudeEffortLevelsForModelId('claude-sonnet-5')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveClaudeDefaultEffortLevelForModelId('claude-sonnet-5')).toBe('high');
  });

  it('marks Opus 4.8 as effort+max capable with xhigh support and high default effort', () => {
    expect(isClaudeEffortSupportedModelId('claude-opus-4-8')).toBe(true);
    expect(isClaudeEffortMaxSupportedModelId('claude-opus-4-8')).toBe(true);
    expect(resolveClaudeEffortLevelsForModelId('claude-opus-4-8')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-8')).toBe('high');
  });

  it('marks Opus 4.7 as effort+max capable with xhigh support', () => {
    expect(isClaudeEffortSupportedModelId('claude-opus-4-7')).toBe(true);
    expect(isClaudeEffortMaxSupportedModelId('claude-opus-4-7')).toBe(true);
    expect(resolveClaudeEffortLevelsForModelId('claude-opus-4-7')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-7')).toBe('xhigh');
  });

  it('marks Opus 4.6 as effort+max capable', () => {
    expect(isClaudeEffortSupportedModelId('claude-opus-4-6')).toBe(true);
    expect(isClaudeEffortMaxSupportedModelId('claude-opus-4-6')).toBe(true);
    expect(resolveClaudeEffortLevelsForModelId('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('marks Sonnet 4.6 as effort-capable but not max-capable', () => {
    expect(isClaudeEffortSupportedModelId('claude-sonnet-4-6')).toBe(true);
    expect(isClaudeEffortMaxSupportedModelId('claude-sonnet-4-6')).toBe(false);
    expect(resolveClaudeEffortLevelsForModelId('claude-sonnet-4-6')).toEqual(['low', 'medium', 'high']);
  });

  it('treats Haiku as not effort-capable', () => {
    expect(isClaudeEffortSupportedModelId('claude-haiku-4-5')).toBe(false);
    expect(resolveClaudeEffortLevelsForModelId('claude-haiku-4-5')).toEqual([]);
  });

  it('resolves effort levels for [1m]-suffixed model ids the same as the bare id (lookup-only strip)', () => {
    expect(resolveClaudeEffortLevelsForModelId('claude-fable-5[1m]')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(resolveClaudeEffortLevelsForModelId('claude-sonnet-4-6[1m]')).toEqual(['low', 'medium', 'high']);
    expect(resolveClaudeEffortLevelsForModelId('Claude-Opus-4-7[1M] ')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('resolves the default effort for [1m]-suffixed model ids', () => {
    expect(resolveClaudeDefaultEffortLevelForModelId('claude-fable-5[1m]')).toBe('high');
    expect(resolveClaudeDefaultEffortLevelForModelId('claude-opus-4-7[1m]')).toBe('xhigh');
  });

  it('does not resolve effort for unknown bracket-suffixed ids', () => {
    expect(resolveClaudeEffortLevelsForModelId('[1m]')).toEqual([]);
    expect(resolveClaudeEffortLevelsForModelId('claude-haiku-4-5[1m]')).toEqual([]);
  });
});

describe('claude ultracode support', () => {
  it('marks xhigh-capable models as ultracode-capable (incl. [1m] variants)', () => {
    expect(isClaudeUltracodeSupportedModelId('claude-fable-5')).toBe(true);
    expect(isClaudeUltracodeSupportedModelId('claude-opus-5')).toBe(true);
    expect(isClaudeUltracodeSupportedModelId('claude-sonnet-5')).toBe(true);
    expect(isClaudeUltracodeSupportedModelId('claude-opus-4-8')).toBe(true);
    expect(isClaudeUltracodeSupportedModelId('claude-opus-4-7')).toBe(true);
    expect(isClaudeUltracodeSupportedModelId('claude-fable-5[1m]')).toBe(true);
  });

  it('marks non-xhigh models as not ultracode-capable', () => {
    expect(isClaudeUltracodeSupportedModelId('claude-opus-4-6')).toBe(false);
    expect(isClaudeUltracodeSupportedModelId('claude-sonnet-4-6')).toBe(false);
    expect(isClaudeUltracodeSupportedModelId('claude-haiku-4-5')).toBe(false);
    expect(isClaudeUltracodeSupportedModelId(undefined)).toBe(false);
  });
});
