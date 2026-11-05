import { describe, expect, it } from 'vitest';
import { bundledUsageModelPriceCatalog, parseLiteLlmModelPriceCatalog, resolveUsageModelPrice, UsageModelPriceOverridesV1Schema } from './usageModelPriceCatalog.js';
import { estimateUsageModelCost, repriceUsageAnalyticsResponse } from './usageCost.js';
import { UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';

describe('canonical model price catalog', () => {
  it('retains exact vendor and extended-context tariffs before legacy fallback aliases', () => {
    const base = { inputUsdPerMillion: 3, outputUsdPerMillion: 15, provider: 'anthropic' };
    const extended = { ...base, inputUsdPerMillion: 6 };
    const vendor = { ...base, inputUsdPerMillion: 9 };
    const catalog = { ...bundledUsageModelPriceCatalog, models: {
      'claude-sonnet-4-6': base, 'claude-sonnet-4-6[1m]': extended, 'anthropic/claude-sonnet-4-6': vendor,
    } };
    expect(resolveUsageModelPrice('claude-sonnet-4-6[1m]', catalog)?.rates).toEqual(extended);
    expect(resolveUsageModelPrice('anthropic/claude-sonnet-4-6', catalog)?.rates).toEqual(vendor);
    const override = { kind: 'rates' as const, inputUsdPerMillion: 12, outputUsdPerMillion: 15 };
    expect(resolveUsageModelPrice('claude-sonnet-4-6[1m]', catalog,
      { 'claude-sonnet-4-6[1m]': override })?.rates).toEqual(override);
    const fallback = { ...catalog, models: { 'claude-sonnet-4-6': base } };
    expect(resolveUsageModelPrice('claude-sonnet-4-6[1m]', fallback)?.rates).toEqual(base);
    expect(resolveUsageModelPrice('anthropic/claude-sonnet-4-6', fallback)?.rates).toEqual(base);
  });

  it('shares Haiku snapshot and alias overrides when repricing history without changing reported money', () => {
    const alias = 'claude-haiku-4-5';
    const dated = 'claude-haiku-4-5-20251001';
    const rates = { kind: 'rates' as const, inputUsdPerMillion: 20, outputUsdPerMillion: 40 };
    const tokens = { total: 1_000_000, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const cost = { reportedUsd: 4, estimatedUsd: 1, currency: 'USD' };
    const raw = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { tokens: { ...tokens, total: 2_000_000, input: 2_000_000 }, cost, eventCount: 2 },
      contributions: [alias, dated].map((modelId, i) => ({ id: String(i), observedAtMs: 10, machineId: null, sessionId: null,
        turnId: null, agentId: 'claude', projectKey: null, workspaceId: null, source: 'native', modelId, tokens, tokenCategories: tokens, cost })) });
    for (const overrideId of [alias, dated]) {
      const overrides = { [overrideId]: rates };
      expect(resolveUsageModelPrice(alias, bundledUsageModelPriceCatalog, overrides)).toMatchObject({ source: 'override', rates });
      expect(resolveUsageModelPrice(dated, bundledUsageModelPriceCatalog, overrides)).toMatchObject({ source: 'override', rates });
      const result = repriceUsageAnalyticsResponse(raw, bundledUsageModelPriceCatalog, overrides, 'api_equivalent');
      expect(result.contributions?.map(row => row.cost.apiEquivalentUsd)).toEqual([20, 20]);
      expect(result.totals.cost.apiEquivalentUsd).toBe(40);
      expect(result.contributions?.map(row => row.cost.reportedUsd)).toEqual([4, 4]);
    }
    // A pre-fix Account can contain both spellings. The canonical entry wins for both.
    const conflicts = { [alias]: rates, [dated]: { ...rates, inputUsdPerMillion: 99 } };
    expect([alias, dated].map(id => estimateUsageModelCost(id, tokens, bundledUsageModelPriceCatalog, conflicts)?.total))
      .toEqual([20, 20]);
    const mapped = { [dated]: { kind: 'map' as const, modelId: 'gpt-5.4' },
      'gpt-5.4': rates };
    expect([alias, dated].map(id => estimateUsageModelCost(id, tokens, bundledUsageModelPriceCatalog, mapped)?.total))
      .toEqual([20, 20]);
    expect(resolveUsageModelPrice('claude-haiku-4-5-20990101')).toBeNull();
    expect(resolveUsageModelPrice('vertex_ai/claude-haiku-4-5')?.modelId).toBe('vertex_ai/claude-haiku-4-5');
  });

  it('projects standard text-token rates from the heterogeneous public file without inventing cache prices', () => {
    const catalog = parseLiteLlmModelPriceCatalog({ sample_spec: {}, model: { mode: 'chat', input_cost_per_token: 0.000002,
      output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.0000002, input_cost_per_token_above_200k_tokens: 9 },
      image: { mode: 'image_generation', input_cost_per_token: 1, output_cost_per_token: 2 },
      malformed: { mode: 'chat', input_cost_per_token: -1, output_cost_per_token: 1 },
      ' ': { mode: 'chat', input_cost_per_token: 1, output_cost_per_token: 1 },
    }, bundledUsageModelPriceCatalog.provenance);
    expect(Object.keys(catalog.models)).toEqual(['model']);
    expect(catalog.models.model).toMatchObject({ inputUsdPerMillion: 2, outputUsdPerMillion: 10 });
    expect(catalog.models.model?.cacheReadUsdPerMillion).toBeCloseTo(0.2);
    expect(resolveUsageModelPrice('malformed', catalog)).toBeNull();
    const tokens = { total: 1_000_000, input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, reasoning: 0 };
    expect(estimateUsageModelCost('model', tokens, catalog)).toBeNull();
    expect(() => parseLiteLlmModelPriceCatalog({ model: { mode: 'chat', input_cost_per_token: -1, output_cost_per_token: 1 } }, catalog.provenance)).toThrow();
  });

  it('keeps unknown models unpriced and applies explicit mappings and overrides without fuzzy matching', () => {
    expect(resolveUsageModelPrice('future-gpt-5.4')).toBeNull();
    const overrides = UsageModelPriceOverridesV1Schema.parse({ custom: { kind: 'map', modelId: 'gpt-5.4' },
      'gpt-5.4': { kind: 'rates', inputUsdPerMillion: 7, outputUsdPerMillion: 11, cacheReadUsdPerMillion: 0 } });
    expect(resolveUsageModelPrice('custom', bundledUsageModelPriceCatalog, overrides)).toMatchObject({ source: 'mapping', modelId: 'gpt-5.4',
      rates: { inputUsdPerMillion: 7, outputUsdPerMillion: 11, cacheReadUsdPerMillion: 0 } });
    expect(UsageModelPriceOverridesV1Schema.safeParse({ a: { kind: 'map', modelId: 'b' }, b: { kind: 'map', modelId: 'a' } }).success).toBe(false);
    // Zod's record projection omits this reserved key; reject rather than silently lose a setting.
    expect(UsageModelPriceOverridesV1Schema.safeParse(Object.fromEntries([
      ['__proto__', { kind: 'rates', inputUsdPerMillion: 7, outputUsdPerMillion: 11 }],
    ])).success).toBe(false);
  });

  it('retains reported money and explicitly unpriced token populations rather than making unknown history zero dollars', () => {
    const tokens = { total: 10, input: 10, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const cost = { reportedUsd: 4, estimatedUsd: 2, currency: 'EUR', costSource: 'provider_reported' };
    const raw = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
      totals: { tokens, cost, eventCount: 1 }, contributions: [{ id: 'row', observedAtMs: 10, machineId: 'machine',
        sessionId: null, turnId: null, agentId: null, projectKey: null, workspaceId: null, source: 'native', modelId: 'unknown', tokens, cost }] });
    const unpriced = repriceUsageAnalyticsResponse(raw, bundledUsageModelPriceCatalog, {}, 'api_equivalent');
    expect(unpriced.totals.cost.apiEquivalentUsd).toBeUndefined();
    expect(unpriced.costPresentation).toBeUndefined();
    expect(unpriced.costFacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'unpriced', amountUsd: null, tokens }),
      expect.objectContaining({ kind: 'reported', amountUsd: 4, currency: 'EUR' })]));
    const priced = repriceUsageAnalyticsResponse(raw, bundledUsageModelPriceCatalog, { unknown: { kind: 'map', modelId: 'gpt-5.4' } }, 'api_equivalent');
    expect(priced.totals.cost.reportedUsd).toBe(4);
    expect(priced.totals.cost.estimatedUsd).toBe(2);
    expect(priced.costPresentation).toMatchObject({ effectiveUsd: 0.000025, currency: 'USD' });
    expect(priced.costFacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'api_equivalent', amountUsd: 0.000025, currency: 'USD' })]));
  });

  it('re-prices aggregate cache value from current tariffs rather than preserving a write-time savings figure', () => {
    const tokens = { total: 1_100_000, input: 1_000_000, output: 0, cacheRead: 100_000, cacheWrite: 0, reasoning: 0 };
    const cost = { reportedUsd: 0, estimatedUsd: 3.03, currency: 'USD', costSource: 'pricing_estimate' };
    const raw = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { tokens, cost, eventCount: 1 },
      insights: { activeDays: 1, longestStreakDays: 1, sessionsUsed: 1, messagesUsed: 1, modelsTried: 1, favoriteModelChangeCount: 0, cacheSavingsUsd: 999 },
      contributions: [{ id: 'cache-row', observedAtMs: 10, machineId: null, sessionId: null, turnId: null, agentId: null,
        projectKey: null, workspaceId: null, source: 'native', modelId: 'claude-sonnet-4-6', tokens, tokenCategories: tokens, cost }] });
    const result = repriceUsageAnalyticsResponse(raw, bundledUsageModelPriceCatalog,
      { 'claude-sonnet-4-6': { kind: 'rates', inputUsdPerMillion: 30, outputUsdPerMillion: 15, cacheReadUsdPerMillion: 3 } });
    expect(result.insights?.cacheSavingsUsd).toBe(2.7);
  });
});
