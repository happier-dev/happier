import { describe, expect, it } from 'vitest';

import {
  buildClaudeEffortCliArgs,
  isClaudeUltracodeSupportedModelId,
  resolveClaudeDefaultEffortLevelForModelId,
  resolveClaudeEffectiveEffortForModel,
  resolveClaudeEffortLevelsForModelId,
} from './reasoningEffort.js';

describe('resolveClaudeEffectiveEffortForModel', () => {
  it('preserves a valid native effort for live control and launch serialization', () => {
    expect(resolveClaudeEffectiveEffortForModel({
      modelId: 'claude-sonnet-4-6',
      effort: 'max',
    })).toBe('max');
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-sonnet-4-6', effort: 'max' }))
      .toEqual(['--effort', 'max']);
  });

  it('uses exact Provider options without native down-clamping or id inference', () => {
    const providerModel = {
      id: 'claude-opus-4-8',
      name: 'Gateway model',
      capabilities: { reasoningControls: 'supported' as const },
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Reasoning',
        type: 'select' as const,
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      }],
    };

    expect(resolveClaudeEffectiveEffortForModel({
      modelId: providerModel.id,
      effort: 'high',
      providerModel,
    })).toBe('high');
    expect(resolveClaudeEffectiveEffortForModel({
      modelId: providerModel.id,
      effort: 'max',
      providerModel,
    })).toBeNull();
    expect(resolveClaudeEffectiveEffortForModel({
      modelId: providerModel.id,
      effort: 'xhigh',
      providerModel: {
        id: providerModel.id,
        name: providerModel.name,
        capabilities: { reasoningControls: 'unknown' as const },
      },
    })).toBeNull();
  });
});

describe('buildClaudeEffortCliArgs', () => {
  it('projects max effort for Sonnet 4.6 without inventing xhigh support', () => {
    expect(resolveClaudeEffortLevelsForModelId('claude-sonnet-4-6'))
      .toEqual(['low', 'medium', 'high', 'max']);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-sonnet-4-6', effort: 'max' }))
      .toEqual(['--effort', 'max']);
  });

  it('treats Fable 5 high as the default effort', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-fable-5', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('treats Opus 5 high as the default effort', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-5', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-5', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('projects all five Sonnet 5 effort levels with high as the default', () => {
    expect(resolveClaudeEffortLevelsForModelId('claude-sonnet-5'))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-sonnet-5', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-sonnet-5', effort: 'xhigh' }))
      .toEqual(['--effort', 'xhigh']);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-sonnet-5', effort: 'max' }))
      .toEqual(['--effort', 'max']);
  });

  it('projects all five Mythos 5 effort levels with high as the default', () => {
    expect(resolveClaudeEffortLevelsForModelId('claude-mythos-5'))
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-mythos-5', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-mythos-5', effort: 'xhigh' }))
      .toEqual(['--effort', 'xhigh']);
  });

  it('treats Opus 4.8 high as the default effort', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-8', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-8', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('treats the generic opus alias as the current flagship Claude model for default effort resolution', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'opus', effort: 'high' })).toEqual([]);
    expect(buildClaudeEffortCliArgs({ modelId: 'opus', effort: 'xhigh' })).toEqual(['--effort', 'xhigh']);
  });

  it('keeps Opus 4.7 behavior where high still requires an explicit override', () => {
    expect(buildClaudeEffortCliArgs({ modelId: 'claude-opus-4-7', effort: 'high' })).toEqual(['--effort', 'high']);
  });

  it('uses exact Provider options without native-id inference or silent downgrade', () => {
    const providerModel = {
      id: 'deepseek-ai/DeepSeek-V3.1',
      name: 'DeepSeek V3.1',
      capabilities: { reasoningControls: 'supported' as const },
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Reasoning',
        type: 'select',
        currentValue: 'medium',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      }],
    };

    expect(buildClaudeEffortCliArgs({
      modelId: providerModel.id,
      effort: 'medium',
      providerModel,
    })).toEqual([]);
    expect(buildClaudeEffortCliArgs({
      modelId: providerModel.id,
      effort: 'high',
      providerModel,
    })).toEqual(['--effort', 'high']);
    expect(buildClaudeEffortCliArgs({
      modelId: providerModel.id,
      effort: 'xhigh',
      providerModel,
    })).toEqual([]);
  });

  it('does not infer reasoning support from a Claude-looking Provider model id', () => {
    expect(buildClaudeEffortCliArgs({
      modelId: 'claude-sonnet-4-6',
      effort: 'low',
      providerModel: {
        id: 'claude-sonnet-4-6',
        name: 'Gateway model',
        capabilities: { reasoningControls: 'unknown' },
      },
    })).toEqual([]);
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
    expect(isClaudeUltracodeSupportedModelId('claude-opus-5')).toBe(true);
    expect(isClaudeUltracodeSupportedModelId('claude-sonnet-5')).toBe(true);
    expect(isClaudeUltracodeSupportedModelId('claude-mythos-5')).toBe(true);
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

  it('does not infer ultracode from Provider model ids', () => {
    expect(isClaudeUltracodeSupportedModelId('claude-opus-4-8', {
      id: 'claude-opus-4-8',
      name: 'Gateway Opus',
      capabilities: { reasoningControls: 'supported' },
      modelOptions: [{
        id: 'reasoning_effort',
        name: 'Reasoning',
        type: 'select',
        currentValue: 'xhigh',
        options: [{ value: 'xhigh', name: 'XHigh' }],
      }],
    })).toBe(false);
  });
});
