import { describe, expect, it } from 'vitest';

import type { AnthropicModelEntry } from './fetchAnthropicModels';
import {
  buildDiscoveredClaudeModelDescriptor,
  deriveClaudeModelOptionsFromCapabilities,
} from './deriveDiscoveredClaudeModel';

function effort(tiers: readonly string[]): AnthropicModelEntry['capabilities'] {
  return {
    effort: {
      supported: true,
      ...Object.fromEntries(tiers.map((tier) => [tier, { supported: true }])),
    },
  };
}

describe('deriveClaudeModelOptionsFromCapabilities', () => {
  it('builds a full 5-tier Thinking select plus Ultracode when xhigh is supported', () => {
    const derived = deriveClaudeModelOptionsFromCapabilities({
      id: 'claude-opus-9',
      maxInputTokens: 1_000_000,
      capabilities: effort(['low', 'medium', 'high', 'xhigh', 'max']),
    });

    expect(derived.contextWindowTokens).toBe(1_000_000);
    const reasoning = derived.modelOptions?.find((o) => o.id === 'reasoning_effort');
    expect(reasoning?.currentValue).toBe('high');
    expect(reasoning?.options?.map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(derived.modelOptions?.some((o) => o.id === 'ultracode' && o.type === 'boolean')).toBe(true);
  });

  it('omits Ultracode when xhigh is not supported', () => {
    const derived = deriveClaudeModelOptionsFromCapabilities({
      id: 'claude-sonnet-9',
      capabilities: effort(['low', 'medium', 'high', 'max']),
    });

    const reasoning = derived.modelOptions?.find((o) => o.id === 'reasoning_effort');
    expect(reasoning?.options?.map((o) => o.value)).toEqual(['low', 'medium', 'high', 'max']);
    expect(derived.modelOptions?.some((o) => o.id === 'ultracode')).toBe(false);
  });

  it('produces no model options when effort is unsupported but still reports the context window', () => {
    const derived = deriveClaudeModelOptionsFromCapabilities({
      id: 'claude-haiku-9',
      maxInputTokens: 200_000,
      capabilities: { effort: { supported: false } },
    });

    expect(derived.modelOptions).toBeUndefined();
    expect(derived.contextWindowTokens).toBe(200_000);
  });

  it('defaults to the nearest tier at or below high when high is not offered', () => {
    // Never silently preselect a tier stronger than the API's own `high` default: a model
    // offering only low/max would otherwise open at max and burn budget the user never chose.
    expect(
      deriveClaudeModelOptionsFromCapabilities({ id: 'claude-mini-9', capabilities: effort(['low', 'medium']) })
        .modelOptions?.find((o) => o.id === 'reasoning_effort')?.currentValue,
    ).toBe('medium');
    expect(
      deriveClaudeModelOptionsFromCapabilities({ id: 'claude-mini-9', capabilities: effort(['low', 'max']) })
        .modelOptions?.find((o) => o.id === 'reasoning_effort')?.currentValue,
    ).toBe('low');
    expect(
      deriveClaudeModelOptionsFromCapabilities({ id: 'claude-mini-9', capabilities: effort(['xhigh', 'max']) })
        .modelOptions?.find((o) => o.id === 'reasoning_effort')?.currentValue,
    ).toBe('xhigh');
  });
});

describe('buildDiscoveredClaudeModelDescriptor', () => {
  it('uses display_name as the name and derives options', () => {
    const descriptor = buildDiscoveredClaudeModelDescriptor({
      id: 'claude-opus-9',
      displayName: 'Opus 9',
      maxInputTokens: 1_000_000,
      capabilities: effort(['low', 'medium', 'high', 'xhigh', 'max']),
    });

    expect(descriptor.id).toBe('claude-opus-9');
    expect(descriptor.name).toBe('Opus 9');
    expect(descriptor.description).toBeUndefined();
    expect(descriptor.contextWindowTokens).toBe(1_000_000);
    expect(descriptor.modelOptions?.some((o) => o.id === 'reasoning_effort')).toBe(true);
  });

  it('falls back to the id when display_name is missing', () => {
    const descriptor = buildDiscoveredClaudeModelDescriptor({ id: 'claude-opus-9' });
    expect(descriptor.name).toBe('claude-opus-9');
  });
});
