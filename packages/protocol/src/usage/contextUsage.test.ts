import { describe, expect, it } from 'vitest';

import * as usage from './index.js';

const validSnapshot = {
  v: 1,
  modelId: 'gpt-5.4',
  usedTokens: 48_000,
  windowTokens: 400_000,
  totalProcessedTokens: 125_000,
  baselineTokens: 12_000,
  isAutoCompactEnabled: true,
  categories: [
    { key: 'messages', label: 'Messages', tokens: 32_000 },
    { key: 'tools', label: null, tokens: 16_000 },
  ],
  observedAtMs: 1_752_089_600_000,
  source: 'provider_turn',
} as const;

describe('SessionContextUsageSnapshotV1Schema', () => {
  it('parses the complete provider snapshot contract', () => {
    expect(usage.SessionContextUsageSnapshotV1Schema.parse(validSnapshot)).toEqual(validSnapshot);
  });

  it('accepts explicit nulls for unavailable provider fields', () => {
    const snapshot = {
      ...validSnapshot,
      modelId: null,
      windowTokens: null,
      totalProcessedTokens: null,
      baselineTokens: null,
      isAutoCompactEnabled: null,
      categories: null,
      source: 'derived_estimate',
    } as const;

    expect(usage.SessionContextUsageSnapshotV1Schema.parse(snapshot)).toEqual(snapshot);
  });

  it.each([
    ['missing required nullable field', (({ categories: _categories, ...snapshot }) => snapshot)(validSnapshot)],
    ['unknown field', { ...validSnapshot, provider: 'codex' }],
    ['negative used tokens', { ...validSnapshot, usedTokens: -1 }],
    ['fractional observed time', { ...validSnapshot, observedAtMs: 1.5 }],
    ['unknown source', { ...validSnapshot, source: 'provider_guess' }],
    ['invalid category', { ...validSnapshot, categories: [{ key: '', label: null, tokens: 1 }] }],
  ])('rejects %s', (_name, candidate) => {
    expect(usage.SessionContextUsageSnapshotV1Schema.safeParse(candidate).success).toBe(false);
  });
});

describe('computeContextPercentUsed', () => {
  it('computes naive utilization when the provider declares no baseline', () => {
    expect(usage.computeContextPercentUsed({
      ...validSnapshot,
      usedTokens: 100_000,
      windowTokens: 400_000,
      baselineTokens: null,
    })).toBe(25);
  });

  it('subtracts provider baseline tokens from both used and window tokens', () => {
    expect(usage.computeContextPercentUsed({
      ...validSnapshot,
      usedTokens: 50_000,
      windowTokens: 100_000,
      baselineTokens: 10_000,
    })).toBeCloseTo(44.444_444, 5);
  });

  it('clamps baseline-adjusted utilization to the valid percentage range', () => {
    expect(usage.computeContextPercentUsed({
      ...validSnapshot,
      usedTokens: 5_000,
      windowTokens: 100_000,
      baselineTokens: 12_000,
    })).toBe(0);
    expect(usage.computeContextPercentUsed({
      ...validSnapshot,
      usedTokens: 120_000,
      windowTokens: 100_000,
      baselineTokens: 12_000,
    })).toBe(100);
  });

  it('returns null when the context window is unavailable or has no usable capacity', () => {
    expect(usage.computeContextPercentUsed({ ...validSnapshot, windowTokens: null })).toBeNull();
    expect(usage.computeContextPercentUsed({
      ...validSnapshot,
      windowTokens: 12_000,
      baselineTokens: 12_000,
    })).toBeNull();
  });
});
