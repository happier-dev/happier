import { describe, expect, it } from 'vitest';

import {
  isClaudeEffortMaxSupportedModelId,
  isClaudeEffortSupportedModelId,
  resolveClaudeEffortLevelsForModelId,
} from './effort.js';

describe('claude effort support', () => {
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
});
