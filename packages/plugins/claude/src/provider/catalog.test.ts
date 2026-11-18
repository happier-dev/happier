import { describe, expect, it } from 'vitest';
import { ProviderModelDescriptorV1Schema } from '@happier-dev/protocol/models/descriptor';

import {
  ANTHROPIC_STATIC_MODELS,
  buildAnthropicModelOptions,
  isAnthropic1mAlwaysOnModelId,
  isAnthropic1mContextOptInModelId,
  normalizeAnthropicModelDisplayName,
  parseClaudeModelCatalog,
  resolveAnthropicDefaultEffortLevelForModelId,
} from './catalog.js';

describe('Anthropic Provider catalog', () => {
  it('publishes a native upstream identity only for a model id the catalog owns', () => {
    const { models } = parseClaudeModelCatalog({ data: [
      { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
      { id: 'proxy/sonnet', display_name: 'Claude Sonnet 4.6' },
    ] });
    const upstreamRef = { vendor: 'anthropic', vendorModelId: 'claude-sonnet-4-6' };
    expect(models[0]?.upstreamRef).toEqual(upstreamRef);
    expect(models[1]?.upstreamRef).toBeUndefined();
  });

  it('uses the catalog effort descriptor default for native model presentation', () => {
    for (const model of ANTHROPIC_STATIC_MODELS) {
      const effort = model.modelOptions?.find(option => option.id === 'reasoning_effort');
      expect(resolveAnthropicDefaultEffortLevelForModelId(` ${model.id.toUpperCase()}[1m] `))
        .toBe(effort?.currentValue ?? null);
    }
    expect(resolveAnthropicDefaultEffortLevelForModelId('unknown-model')).toBeNull();
  });

  it('publishes low-cost model tier through the strict model descriptor consumed by model admission', () => {
    const haiku = ANTHROPIC_STATIC_MODELS.find(({ id }) => id === 'claude-haiku-4-5');
    expect(ProviderModelDescriptorV1Schema.parse(haiku)).toMatchObject({
      costTier: 'low', name: 'Haiku 4.5', aliases: ['claude-haiku-4-5-20251001'],
    });
  });
  it('uses provider-relative labels without rewriting non-Anthropic gateway names', () => {
    expect(normalizeAnthropicModelDisplayName('Claude Future 6', 'claude-future-6')).toBe('Future 6');
    expect(normalizeAnthropicModelDisplayName('GLM 4.6', 'glm-4.6')).toBe('GLM 4.6');
    expect(normalizeAnthropicModelDisplayName(undefined, 'claude-future-6')).toBe('claude-future-6');
  });

  it('publishes the current Fable and Opus models with their documented controls', () => {
    const fable = ANTHROPIC_STATIC_MODELS.find(({ id }) => id === 'claude-fable-5-1');
    const opus = ANTHROPIC_STATIC_MODELS.find(({ id }) => id === 'claude-opus-5-5');
    expect(fable).toMatchObject({ name: 'Fable 5.1', contextWindowTokens: 1_000_000 });
    expect(opus).toMatchObject({ name: 'Opus 5.5', contextWindowTokens: 1_000_000 });
    expect(fable?.modelOptions).toEqual(buildAnthropicModelOptions({
      supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    }));
    expect(opus?.modelOptions).toEqual(buildAnthropicModelOptions({
      supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
    }));
    expect(isAnthropic1mAlwaysOnModelId('claude-fable-5-1')).toBe(true);
    expect(isAnthropic1mAlwaysOnModelId('claude-opus-5-5')).toBe(true);
  });

  it('owns the static model options consumed by both Provider discovery and the Claude Agent', () => {
    expect(ANTHROPIC_STATIC_MODELS.find(({ id }) => id === 'claude-opus-5')?.modelOptions)
      .toEqual(buildAnthropicModelOptions({
        supportedLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high',
      }));
    expect(isAnthropic1mAlwaysOnModelId('claude-opus-5')).toBe(true);
    expect(isAnthropic1mContextOptInModelId('claude-opus-4-6')).toBe(true);
    expect(ANTHROPIC_STATIC_MODELS.find(({ id }) => id === 'claude-opus-4-6')?.extendedContextModelId)
      .toBe('claude-opus-4-6[1m]');
  });
});
