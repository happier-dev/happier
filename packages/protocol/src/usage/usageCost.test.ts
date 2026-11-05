import { withUsageMoney, readUsageMoney } from './usageMoney.js';
import { expect, it } from 'vitest';
import { admitUsageAnalyticsServerPrices, projectUsageAnalyticsSummary, projectUsagePageCost, repriceUsageAnalyticsResponse, repriceUsageAnalyticsResponseSteps, repriceUsageObservationCost, resolveUsageCostFacts, resolveUsageCostBasis, resolveEffectiveUsageCostUsd } from './usageCost.js';
import { bundledUsageModelPriceCatalog } from './usageModelPriceCatalog.js';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { addUsageCostForMode, createEmptyUsageCost } from './usageAggregation.js';
import { buildUsagePricingPopulation, createUsagePricedPartitionBuilder, priceUsagePricingPopulation } from './usagePricingPopulation.js';

it('suspends pricing only when its host checkpoint is due', () => {
  const tokens = { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
  const cost = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD' };
  const value: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 128, tokens, cost },
    contributions: Array.from({ length: 128 }, (_, index) => ({ id: String(index), eventCount: 1,
      observedAtMs: index, sessionId: null, turnId: null, agentId: null, modelId: 'gpt-4o',
      machineId: null, projectKey: null, workspaceId: null, source: null, tokens, tokenCategories: tokens, cost })) };
  const steps = repriceUsageAnalyticsResponseSteps(value, undefined, {}, 'auto', undefined, () => false);
  const first = steps.next();
  expect(first.done, 'an unexpired host slice must not suspend once per row or nested money operand').toBe(true);
  if (!first.done) throw new Error('Expected pricing to finish in the admitted host slice');
  expect(JSON.stringify(first.value)).toBe(JSON.stringify(repriceUsageAnalyticsResponse(value)));

  // The checkpoint is a host clock boundary. Simulate one millisecond of work
  // per first row admission without mocking any pricing or aggregation logic.
  let elapsedMs = 0;
  let sliceStartedAt = 0;
  const admitted = new Set<number>();
  const measured = { ...value, contributions: value.contributions!.map((row, index) => ({ ...row,
    get cost() { if (!admitted.has(index)) { admitted.add(index); elapsedMs++; } return row.cost; },
  })) };
  const timed = repriceUsageAnalyticsResponseSteps(measured, undefined, {}, 'auto', undefined,
    () => elapsedMs - sliceStartedAt >= 20);
  let next = timed.next();
  let suspensions = 0;
  while (!next.done) {
    suspensions++;
    expect(admitted.size).toBe(suspensions * 20);
    sliceStartedAt = elapsedMs;
    next = timed.next();
  }
  expect(suspensions).toBe(6);
  expect(JSON.stringify(next.value)).toBe(JSON.stringify(first.value));
});

it('builds requested rankings directly from the priced population without preliminary money rankings', () => {
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const cost = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD' };
  const value: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 2, tokens, cost }, contributions: ['a', 'b'].map((modelId, index) => ({
    id: String(index), eventCount: 1, observedAtMs: 100, sessionId: String(index), turnId: null, agentId: 'codex', modelId,
    machineId: null, projectKey: null, workspaceId: null, source: null, tokens, tokenCategories: tokens, cost,
  })) };
  const catalog = { ...bundledUsageModelPriceCatalog, models: {
    a: { inputUsdPerMillion: 3, outputUsdPerMillion: 0 }, b: { inputUsdPerMillion: 7, outputUsdPerMillion: 0 },
  } };
  const demand = UsageAnalyticsQueryRequestSchema.parse({ breakdowns: ['model'], includeLeaders: true, topLimit: 1 });
  const projected = repriceUsageAnalyticsResponse(value, catalog, {}, 'auto', demand);
  expect(projected.breakdowns?.model?.map(entry => [entry.key, entry.cost.apiEquivalentUsd])).toEqual([['b', 7]]);
  expect(projected.leaders?.models?.map(entry => entry.key)).toEqual(['b']);
  expect(projected.contributions).toHaveLength(2);
  const changed = repriceUsageAnalyticsResponse(value, { ...catalog, models: { ...catalog.models, a: { inputUsdPerMillion: 9, outputUsdPerMillion: 0 } } }, {}, 'auto', demand);
  expect(changed.breakdowns?.model?.map(entry => [entry.key, entry.cost.apiEquivalentUsd])).toEqual([['a', 9]]);
});

it('resolves repeated row and compact group tariffs in proportion to distinct models per projection', () => {
  for (const count of [2, 128]) {
    const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
    const cost = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD' };
    const rows = Array.from({ length: count }, (_, index) => ({ id: String(index), observedAtMs: index,
      sessionId: null, turnId: null, agentId: null, modelId: `model-${index % 2}`, machineId: null, projectKey: null,
      workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost }));
    let lookups = 0;
    let overrideScans = 0;
    const catalog = { ...bundledUsageModelPriceCatalog, models: new Proxy({
      'model-0': { inputUsdPerMillion: 7, outputUsdPerMillion: 0 },
      'model-1': { inputUsdPerMillion: 9, outputUsdPerMillion: 0 },
    }, { get(target, key, receiver) { lookups++; return Reflect.get(target, key, receiver); } }) };
    const overrides = new Proxy({ 'unrelated-alias': { kind: 'map' as const, modelId: 'model-0' } }, {
      ownKeys(target) { overrideScans++; return Reflect.ownKeys(target); },
    });
    const value: UsageAnalyticsQueryResponse = { v: 1, contributions: rows, totals: { eventCount: count, tokens, cost } };
    const rich = repriceUsageAnalyticsResponse(value, catalog, overrides);
    expect(rich.totals.cost.apiEquivalentUsd).toBe(8 * count);
    expect({ lookups, overrideScans }).toEqual({ lookups: 2, overrideScans: 2 });
    // Separate admitted partitions can carry the same model tariff.
    const population = { groups: rows.flatMap(row => buildUsagePricingPopulation([row]).groups) };
    expect(population.groups).toHaveLength(count);
    lookups = overrideScans = 0;
    expect(priceUsagePricingPopulation(population, catalog, overrides, 'auto').apiEquivalentUsd).toBe(8 * count);
    expect({ lookups, overrideScans }).toEqual({ lookups: 2, overrideScans: 2 });
    // A later projection must observe a changed tariff, rather than retain a price by model globally.
    expect(repriceUsageAnalyticsResponse(value, { ...catalog, models: {
      'model-0': { inputUsdPerMillion: 11, outputUsdPerMillion: 0 },
      'model-1': { inputUsdPerMillion: 9, outputUsdPerMillion: 0 },
    } }, overrides).totals.cost.apiEquivalentUsd).toBe(10 * count);
  }
});

it('lets native callbacks settle between pricing contributions and preserves the synchronous bytes', async () => {
  const { setImmediate: nextTurn } = await import('node:timers/promises');
  for (const count of [2, 128]) {
    let settled = false;
    const observed = new Map<number, boolean>();
    let pending: Promise<void> | undefined;
    const tokens = { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
    const value: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: count, tokens,
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: Array.from({ length: count }, (_, index) => ({
        id: String(index), modelId: 'gpt-4o', observedAtMs: index, eventCount: 1, tokens, tokenCategories: tokens,
        sessionId: null, turnId: null, agentId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
        get cost() {
          if (!observed.has(index)) observed.set(index, settled);
          pending ??= nextTurn().then(() => { settled = true; });
          return { reportedUsd: 0, estimatedUsd: 0.1, currency: 'USD' };
        },
      })) };
    try {
      const steps = repriceUsageAnalyticsResponseSteps(value);
      let next = steps.next();
      while (!next.done) { await nextTurn(); next = steps.next(); }
      expect(observed.get(0)).toBe(false);
      expect(observed.get(1), 'the next pricing input must service an earlier native callback').toBe(true);
      expect(JSON.stringify(next.value)).toBe(JSON.stringify(repriceUsageAnalyticsResponse(value)));
    } finally { await pending; }
  }
});

it('admits tariff-independent row metadata once across overlapping priced partitions in one projection', () => {
  for (const count of [2, 128]) {
    let categoryReads = 0;
    const tokens = { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
    const rows = Array.from({ length: count }, (_, index) => ({ id: String(index), modelId: 'model', observedAtMs: index,
      eventCount: 1, tokens, get tokenCategories() { categoryReads++; return tokens; },
      cost: { reportedUsd: 0, estimatedUsd: 0.1, apiEquivalentUsd: 0.2, pricingSource: 'catalog', currency: 'USD' } }));
    const build = createUsagePricedPartitionBuilder('auto').build;
    const whole = build(rows);
    const half = build(rows.slice(0, count / 2));
    const repeated = build([...rows]);
    expect(whole.cost).toEqual(repeated.cost);
    expect(whole.population.groups[0]!.contributionCount).toBe(count);
    expect(half.population.groups[0]!.contributionCount).toBe(count / 2);
    expect(categoryReads, 'partition membership changes sums, not admission of the same row metadata').toBe(count);
    const anotherRequest = createUsagePricedPartitionBuilder('auto').build;
    anotherRequest(rows);
    expect(categoryReads).toBe(count * 2);
  }
});

it('calculates repeated exact tariff operands once per projection, without conflating hidden precision or later prices', () => {
  for (const count of [2, 128]) {
    let availabilityReads = 0;
    const catalog = { ...bundledUsageModelPriceCatalog, models: { model: {
      inputUsdPerMillion: 7, outputUsdPerMillion: 0,
      get cacheReadUsdPerMillion() { availabilityReads++; return 2; },
    } } };
    const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0, total: 2_000_000 };
    const cost = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD' };
    const value: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: count, tokens, cost },
      contributions: Array.from({ length: count }, (_, index) => ({ id: String(index), eventCount: 1, observedAtMs: index,
        sessionId: null, turnId: null, agentId: null, modelId: 'model', machineId: null, projectKey: null,
        workspaceId: null, source: null, tokens, tokenCategories: { ...tokens }, cost })) };
    expect(repriceUsageAnalyticsResponse(value, catalog).totals.cost.apiEquivalentUsd).toBe(count * 9);
    // Tariff data is an external catalog boundary. Re-reading availability per
    // equal operand witnesses a repeated estimate, rather than a metadata fold.
    expect(availabilityReads, `${count} equal token operands need one estimate`).toBe(4);
    const changed = { ...catalog, models: { model: { inputUsdPerMillion: 11, outputUsdPerMillion: 0, cacheReadUsdPerMillion: 2 } } };
    expect(repriceUsageAnalyticsResponse(value, changed).totals.cost.apiEquivalentUsd).toBe(count * 13);
    const precise = value.contributions!.slice(0, 2).map((row, index) => ({ ...row,
      tokenCategories: withUsageMoney({ ...tokens, input: 1 }, { input: { units: 10_000_000_000_000_000n + BigInt(index), scale: 16 } }) }));
    const priced = repriceUsageAnalyticsResponse({ ...value, contributions: precise }, catalog).contributions!;
    const exact = priced.map(row => readUsageMoney(row.cost, 'apiEquivalentUsd', row.cost.apiEquivalentUsd!));
    expect(exact[0]).not.toEqual(exact[1]);
  }
});

it('prices each real contribution or compact tariff group once for both selected money and cache savings', () => {
  for (const count of [1, 128]) {
    const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0, total: 2_000_000 };
    const cost = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate' as const };
    const rows = Array.from({ length: count }, (_, index) => ({ id: String(index), observedAtMs: 500,
      sessionId: null, turnId: null, agentId: null, modelId: `model-${index}`, machineId: null, projectKey: null,
      workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost }));
    let lookups = 0;
    const models = Object.fromEntries(rows.map(row => [row.modelId,
      { inputUsdPerMillion: 7, outputUsdPerMillion: 0, cacheReadUsdPerMillion: 2 }]));
    const catalog = { ...bundledUsageModelPriceCatalog, models: new Proxy(models, {
      get(target, key, receiver) { lookups++; return Reflect.get(target, key, receiver); },
    }) };
    const rich = repriceUsageAnalyticsResponse({ v: 1, contributions: rows,
      totals: { eventCount: count, tokens, cost }, insights: { activeDays: 1, longestStreakDays: 1,
        sessionsUsed: 0, messagesUsed: 0, modelsTried: count, favoriteModelChangeCount: 0, cacheSavingsUsd: 0 } }, catalog);
    expect(rich.totals.cost.apiEquivalentUsd).toBe(9 * count);
    expect(rich.insights?.cacheSavingsUsd).toBe(5 * count);
    expect(lookups, `${count} contributions need one tariff estimate each`).toBe(count);
    const population = buildUsagePricingPopulation(rows);
    expect(population.groups).toHaveLength(count);
    lookups = 0;
    const compact = priceUsagePricingPopulation(population, catalog, {}, 'auto');
    expect(compact.apiEquivalentUsd).toBe(9 * count);
    expect(compact.cacheSavingsUsd).toBe(5 * count);
    expect(lookups, `${count} compact groups need one tariff estimate each`).toBe(count);
  }
});

it('reuses only network-admitted compact server prices; private, catalog, mode and rich projections remain live', () => {
  const catalog = { ...bundledUsageModelPriceCatalog, models: { model: { inputUsdPerMillion: 7, outputUsdPerMillion: 0 } } };
  const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 0, endMs: 1000 } });
  for (const count of [1, 128]) {
    const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
    const cost = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate' as const };
    const rich = repriceUsageAnalyticsResponse({ v: 1, priceCatalog: catalog,
      totals: { eventCount: count, tokens: { ...tokens, input: count * tokens.input, total: count * tokens.total }, cost },
      contributions: Array.from({ length: count }, (_, index) => ({ id: String(index), observedAtMs: 500,
        sessionId: null, turnId: null, agentId: null, modelId: 'model', machineId: null, projectKey: null,
        workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost })) });
    const compact = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(projectUsageAnalyticsSummary(rich, query))));
    const admitted = admitUsageAnalyticsServerPrices(compact, query);
    let lookups = 0;
    const models = admitted.priceCatalog!.models;
    admitted.priceCatalog!.models = new Proxy(models, { get(target, key, receiver) { lookups++; return Reflect.get(target, key, receiver); } });
    expect(repriceUsageAnalyticsResponse(admitted)).toBe(admitted);
    expect(lookups, `${count} rows' grouped facts were already priced by the server`).toBe(0);
    expect(JSON.stringify(admitted)).toBe(JSON.stringify(compact));
    expect(projectUsagePageCost(admitted, 'auto').amountUsd).toBe(count * 7);
    const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 9, outputUsdPerMillion: 0 } };
    const privatePrices = repriceUsageAnalyticsResponse(admitted, catalog, overrides);
    expect(privatePrices.totals.cost.apiEquivalentUsd).toBe(count * 9);
    const serializedPrivate = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(privatePrices)));
    expect(repriceUsageAnalyticsResponse(serializedPrivate, catalog, {}).totals.cost.apiEquivalentUsd).toBe(count * 7);
    expect(repriceUsageAnalyticsResponse(admitted, catalog, {}, 'estimated').totals.cost.effectiveUsd).toBe(count);
    const updatedCatalog = { ...catalog, models: { model: { inputUsdPerMillion: 11, outputUsdPerMillion: 0 } } };
    expect(repriceUsageAnalyticsResponse({ ...admitted, priceCatalog: updatedCatalog }).totals.cost.apiEquivalentUsd).toBe(count * 11);
    // Neither a different producer revision/mode nor raw detail is proof of a
    // completed local exact-money projection.
    const mismatch = { ...compact, summary: { ...compact.summary!, catalogRevision: 'other' } };
    expect(admitUsageAnalyticsServerPrices(mismatch, query)).toBe(mismatch);
    expect(admitUsageAnalyticsServerPrices(compact, { ...query, costMode: 'estimated' })).toBe(compact);
    expect(admitUsageAnalyticsServerPrices(rich, query)).toBe(rich);
  }
});

it('admits raw decimal operands once before pricing partitions fan out and replaces changed numeric operands', () => {
  const priced = repriceUsageObservationCost({ reportedUsd: 0.1, estimatedUsd: 0.2, invoiceUsd: 0.3,
    breakdown: { credit: 0.4 }, currency: 'USD', costSource: 'provider_reported' }, null, null);
  for (const field of ['reportedUsd', 'estimatedUsd', 'invoiceUsd'] as const) {
    const value = priced[field]!;
    const admitted = readUsageMoney(priced, field, value);
    for (let partition = 0; partition < 8; partition++) expect(readUsageMoney(priced, field, value)).toBe(admitted);
    expect(readUsageMoney({ ...priced, [field]: 0.9 }, field, 0.9)).not.toBe(admitted);
  }
  const admittedBreakdown = readUsageMoney(priced.breakdown!, 'credit', 0.4);
  expect(readUsageMoney(priced.breakdown!, 'credit', 0.4)).toBe(admittedBreakdown);
});

it('selects only the requested monetary fact without repricing discarded kinds in every ranking partition', () => {
  const priced = repriceUsageObservationCost({ reportedUsd: 0.1, estimatedUsd: 0.2, currency: 'USD', costSource: 'provider_reported' }, null, null);
  let estimatedReads = 0;
  Object.defineProperty(priced, 'estimatedUsd', { enumerable: true, get() { estimatedReads++; return 0.2; } });
  for (let partition = 0; partition < 8; partition++) expect(resolveUsageCostBasis(priced, 'auto')).toMatchObject({ kind: 'reported', amountUsd: 0.1 });
  expect(estimatedReads, 'an available reported fact precedes estimated money').toBe(0);
  expect(resolveUsageCostBasis(priced, 'estimated')).toMatchObject({ kind: 'estimated', amountUsd: 0.2 });
  expect(estimatedReads).toBe(1);
  expect(resolveUsageCostFacts(priced).map(fact => fact.kind)).toEqual(['reported', 'estimated']);
});

it('reuses the completed cost projection across refreshes with unchanged accounting rows', () => {
  const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
  const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const };
  const raw: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 100, tokens, cost },
    coverage: { status: 'complete', reasons: [], ranked: [], missingDimensions: [], range: { startMs: 0, endMs: 100, complete: true },
      sources: [{ source: 'runtime', path: 'runtime', status: 'available', machineId: 'machine', eventCount: 100 }] },
    contributions: Array.from({ length: 100 }, (_, index) => ({ id: String(index), observedAtMs: index,
      sessionId: null, turnId: null, agentId: 'claude', modelId: null, machineId: null, projectKey: null,
      workspaceId: null, source: 'runtime', eventCount: 1, tokens, cost })) };
  const priced = repriceUsageAnalyticsResponse(raw);
  const initial = projectUsagePageCost(priced, 'auto');
  const located = { ...priced, coverage: { ...priced.coverage!, sources: priced.coverage!.sources.map(source => ({ ...source, displayLocation: 'Current machine' })) } };
  let costReads = 0;
  for (const row of priced.contributions!) {
    const cost = row.cost;
    Object.defineProperty(row, 'cost', { enumerable: true, get() { costReads++; return cost; } });
  }
  for (const response of [priced, located]) {
    expect(repriceUsageAnalyticsResponse(response)).toBe(response);
    expect(costReads, 'a pending refresh must retain the completed tariff projection').toBe(0);
    const page = projectUsagePageCost(response, 'auto');
    expect(page.amountUsd).toBe(100);
    expect(costReads, 'independent refresh facts cannot re-aggregate settled accounting').toBe(0);
    expect(page.accounting.contributions).toBe(initial.accounting.contributions);
    expect(projectUsagePageCost(response, 'auto')).toBe(page);
    if (response === located) expect(page.accounting.coverage!.sources[0]).toHaveProperty('displayLocation', 'Current machine');
  }
  expect(costReads, 'independent refresh facts cannot re-aggregate settled accounting').toBe(0);
  // Replacing the population invalidates its projection even when all other
  // fields were copied from a fully priced response.
  expect(projectUsagePageCost({ ...priced, contributions: priced.contributions!.slice(0, 1) }, 'auto').amountUsd).toBe(1);
  expect(projectUsagePageCost(priced, 'reported').amountUsd).toBe(100);
  for (const cost of [
    { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const },
    { reportedUsd: 2, estimatedUsd: 0, currency: 'EUR', costSource: 'provider_reported' as const },
  ]) {
    const partial = repriceUsageAnalyticsResponse({ ...raw, contributions: [raw.contributions![0]!,
      { ...raw.contributions![1]!, cost }] });
    const native = projectUsagePageCost(partial, 'auto');
    const transported = projectUsagePageCost(UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify(partial))), 'auto');
    expect({ selection: native.selection, amountUsd: native.amountUsd }).toEqual({ selection: transported.selection, amountUsd: transported.amountUsd });
  }
});

it('never reclassifies a mixed aggregate with none provenance as reported money', () => {
  const mixed = { reportedUsd: 4, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const };
  expect(resolveUsageCostBasis(mixed, 'reported')).toBeNull();
  expect(resolveEffectiveUsageCostUsd(mixed, 'reported')).toBe(0);
});

it('recognizes explicit zero pricing while leaving default zero unpriced', () => {
  const zero = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
  expect(resolveUsageCostBasis({ ...zero, costSource: 'none' }, 'auto')).toBeNull();
  expect(resolveUsageCostBasis({ ...zero, costSource: 'pricing_estimate' }, 'auto')).toMatchObject({ kind: 'estimated', amountUsd: 0 });
});

it('does not restore an incomplete API tariff population when a later row is priced', () => {
  const unpriced = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const };
  const priced = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate' as const, apiEquivalentUsd: 9 };
  const cost = addUsageCostForMode(addUsageCostForMode(createEmptyUsageCost(), unpriced, 'api_equivalent'), priced, 'api_equivalent');
  expect(cost.apiEquivalentUsd).toBeUndefined();
  expect(resolveUsageCostBasis(cost, 'api_equivalent')).toBeNull();
});

it('keeps a money-only final from invalidating fully priced token accounting', () => {
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const cost = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate' };
  const response: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 2, tokens,
    cost: { reportedUsd: 7, estimatedUsd: 1, currency: 'USD', costSource: 'none' } },
    contributions: [{ id: 'inference', observedAtMs: 1, sessionId: 'session', turnId: 'turn', agentId: 'claude',
      modelId: 'priced-model', machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens, cost },
      { id: 'final', observedAtMs: 2, sessionId: 'session', turnId: null, agentId: 'claude', modelId: null,
        machineId: null, projectKey: null, workspaceId: null, source: 'final', tokens: zero,
        cost: { reportedUsd: 7, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' } }],
  };
  const result = repriceUsageAnalyticsResponse(response, { v: 1,
    models: { 'priced-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 3 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'fixture', fetchStatus: 'ready' },
  }, {}, 'api_equivalent');
  expect(result.totals.cost.apiEquivalentUsd).toBe(2);
  expect(result.costPresentation).toMatchObject({ mode: 'api_equivalent', effectiveUsd: 2 });
  expect(projectUsagePageCost(result, 'api_equivalent').amountUsd).toBe(2);
  expect(result.costFacts?.some(fact => fact.kind === 'unpriced')).toBe(false);
});

it('keeps vendor API-equivalent reports a separate reported fact regardless of current tariff availability', () => {
  const raw = { reportedUsd: 7, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported_api_equivalent' as const };
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const unpriced = repriceUsageObservationCost(raw, 'private-model', tokens);
  expect(resolveUsageCostFacts(unpriced)).toContainEqual(expect.objectContaining({ kind: 'reported', amountUsd: 7,
    source: 'provider_reported_api_equivalent' }));
  const priced = repriceUsageObservationCost(raw, 'private-model', tokens, bundledUsageModelPriceCatalog,
    { 'private-model': { kind: 'rates', inputUsdPerMillion: 2, outputUsdPerMillion: 3 } }, 'api_equivalent');
  expect(priced).toMatchObject({ ...raw, apiEquivalentUsd: 2, effectiveUsd: 2 });
  expect(resolveUsageCostFacts(priced)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'reported', amountUsd: 7, source: 'provider_reported_api_equivalent' }),
    expect.objectContaining({ kind: 'api_equivalent', amountUsd: 2 }),
  ]));
});

it('prefers reported money for best available while keeping invoice and estimates separate', () => {
  const cost = { reportedUsd: 0.12, estimatedUsd: 0.09, invoiceUsd: 0.08, currency: 'USD' };
  expect(resolveUsageCostBasis(cost, 'auto')).toMatchObject({ kind: 'reported', amountUsd: 0.12 });
  expect(resolveUsageCostFacts(cost)).toContainEqual(expect.objectContaining({ kind: 'invoice', amountUsd: 0.08 }));
  expect(resolveUsageCostBasis(cost, 'reported')).toMatchObject({ kind: 'reported', amountUsd: 0.12 });
  expect(resolveUsageCostBasis(cost, 'estimated')).toMatchObject({ kind: 'estimated', amountUsd: 0.09 });
});

it('returns an admitted API-equivalent query mode through the strict response contract', () => {
  const request = UsageAnalyticsQueryRequestSchema.parse({ costMode: 'api_equivalent' });
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const cost = { reportedUsd: 7, estimatedUsd: 0, currency: 'USD' };
  const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1, tokens, cost },
    contributions: [{ id: 'observed', observedAtMs: 1, sessionId: 'session', turnId: null, agentId: null,
      modelId: 'priced-model', machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens, cost }],
  });
  const repriced = repriceUsageAnalyticsResponse(response, {
    v: 1, models: { 'priced-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 3 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'fixture', fetchStatus: 'ready' },
  }, {}, request.costMode);
  expect(UsageAnalyticsQueryResponseSchema.parse(repriced).costPresentation)
    .toMatchObject({ mode: 'api_equivalent', effectiveUsd: 2, currency: 'USD' });
  expect(repriced.totals.cost.reportedUsd).toBe(7);
});

it('projects one common page basis without repricing witnessed facts or changing observation auto precedence', () => {
  const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
  const costs = [
    { reportedUsd: 3, estimatedUsd: 4, invoiceUsd: 2, apiEquivalentUsd: 8, currency: 'USD' },
    { reportedUsd: 5, estimatedUsd: 6, apiEquivalentUsd: 9, currency: 'USD' },
  ];
  const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
    totals: { eventCount: 2, tokens: { ...tokens, total: 2 }, cost: { reportedUsd: 8, estimatedUsd: 10, currency: 'USD', costSource: 'none' } },
    contributions: costs.map((cost, index) => ({ id: String(index), observedAtMs: index, eventCount: 1,
      sessionId: 'session', turnId: null, agentId: 'claude', modelId: 'private', machineId: null,
      projectKey: null, workspaceId: null, source: 'runtime', tokens, cost })),
  });
  const page = projectUsagePageCost(response, 'auto');
  expect(page).toMatchObject({ selection: { kind: 'reported', currency: 'USD' }, amountUsd: 8 });
  expect(page.accounting.contributions).toEqual(response.contributions);
  expect(resolveUsageCostBasis(costs[0]!, 'auto')?.kind).toBe('reported');
  expect(projectUsagePageCost(response, 'api_equivalent')).toMatchObject({ amountUsd: 17,
    selection: { kind: 'api_equivalent', currency: 'USD' } });
  expect(projectUsagePageCost(response, 'auto', { kind: 'invoice', currency: 'USD' }).amountUsd).toBeNull();
  expect(projectUsagePageCost(response, 'auto', { kind: 'reported', currency: 'EUR' }).amountUsd).toBeNull();
});

it('sums best available reported and priced rows with a mixed label, keeping unknown and currencies separate', () => {
  const reported = { reportedUsd: 3, estimatedUsd: 4, apiEquivalentUsd: 8, currency: 'USD' };
  const priced = { reportedUsd: 0, estimatedUsd: 6, apiEquivalentUsd: 9, currency: 'USD', costSource: 'pricing_estimate' as const };
  const mixed = addUsageCostForMode(addUsageCostForMode(createEmptyUsageCost(), reported, 'auto'), priced, 'auto');
  expect(resolveUsageCostBasis(mixed, 'auto')).toMatchObject({ kind: 'mixed', amountUsd: 12, currency: 'USD' });
  expect(resolveUsageCostBasis(addUsageCostForMode(mixed, { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' }, 'auto'), 'auto')).toBeNull();
  expect(resolveUsageCostBasis(addUsageCostForMode(mixed, { ...reported, currency: 'EUR' }, 'auto'), 'auto')).toBeNull();
  expect(resolveUsageCostBasis(addUsageCostForMode(reported, priced, 'reported'), 'reported')).toBeNull();
  expect(resolveUsageCostFacts(mixed)).toContainEqual(expect.objectContaining({ kind: 'reported', amountUsd: 3 }));
  expect(mixed.costSource).toBe('none');
  expect(addUsageCostForMode(addUsageCostForMode(createEmptyUsageCost(), priced, 'auto'), reported, 'auto').costSource).toBe('none');
});

it('uses the admitted selected presentation after JSON transport when contribution detail is absent', () => {
  const reported = { reportedUsd: 10, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const };
  const estimated = { reportedUsd: 0, estimatedUsd: 10, currency: 'USD', costSource: 'pricing_estimate' as const };
  const aggregate = addUsageCostForMode(addUsageCostForMode(createEmptyUsageCost(), reported, 'auto'), estimated, 'auto');
  const wire = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify({ v: 1,
    totals: { eventCount: 2, tokens: { input: 2, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: aggregate },
    costPresentation: { mode: 'auto', effectiveUsd: 20, currency: 'USD', source: 'best_available' },
  })));
  expect(wire.totals.cost).toMatchObject({ reportedUsd: 10, estimatedUsd: 10, costSource: 'none' });
  expect(projectUsagePageCost(wire, 'auto')).toMatchObject({ selection: { kind: 'mixed', currency: 'USD', mode: 'auto' }, amountUsd: 20 });
  expect(projectUsagePageCost(wire, 'reported').amountUsd).toBeNull();
  expect(projectUsagePageCost(wire, 'auto', { kind: 'reported', currency: 'USD' }).amountUsd).toBeNull();
  expect(projectUsagePageCost(wire, 'auto', { kind: 'mixed', currency: 'EUR', mode: 'auto' }).amountUsd).toBeNull();
});

it('re-prices best-available totals and buckets with the same mixed basis as their leaders', () => {
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const costs = [
    { reportedUsd: 3, estimatedUsd: 4, currency: 'USD', costSource: 'provider_reported' },
    { reportedUsd: 0, estimatedUsd: 6, currency: 'USD', costSource: 'pricing_estimate' },
  ];
  const total = { eventCount: 2, tokens: { ...tokens, input: 2_000_000, total: 2_000_000 },
    cost: { reportedUsd: 3, estimatedUsd: 10, currency: 'USD', costSource: 'none' } };
  const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: total,
    series: [{ ...total, bucketStartMs: 0, bucketEndMs: 10 }],
    leaders: { agents: [{ key: 'claude', ...total }] },
    contributions: costs.map((cost, index) => ({ id: String(index), observedAtMs: index, eventCount: 1,
      sessionId: 'session', turnId: null, agentId: 'claude', modelId: 'priced-model', machineId: null,
      projectKey: null, workspaceId: null, source: 'runtime', tokens, cost })),
  });
  const result = UsageAnalyticsQueryResponseSchema.parse(repriceUsageAnalyticsResponse(response, {
    v: 1, models: { 'priced-model': { inputUsdPerMillion: 9, outputUsdPerMillion: 0 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'fixture', fetchStatus: 'ready' },
  }));
  expect(result.totals.cost).toMatchObject({ reportedUsd: 3, estimatedUsd: 10, apiEquivalentUsd: 18, effectiveUsd: 12 });
  expect(result.series?.[0]?.cost.effectiveUsd).toBe(12);
  expect(result.leaders?.agents?.[0]?.cost?.effectiveUsd).toBe(12);
  expect(result.costPresentation).toMatchObject({ mode: 'auto', effectiveUsd: 12, currency: 'USD', source: 'best_available' });
  expect(result.totals.cost.costSource).toBe('none');
  expect(projectUsagePageCost(JSON.parse(JSON.stringify(result)), 'auto')).toMatchObject({
    selection: { kind: 'mixed', currency: 'USD' }, amountUsd: 12,
  });
  expect(result.costFacts).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'reported', amountUsd: 3 }),
    expect.objectContaining({ kind: 'estimated', amountUsd: 10 }),
    expect.objectContaining({ kind: 'api_equivalent', amountUsd: 18 }),
  ]));
});

it('distinguishes witnessed zero from absent money in the page projection', () => {
  const response = (costSource: 'none' | 'provider_reported') => UsageAnalyticsQueryResponseSchema.parse({ v: 1,
    totals: { eventCount: 1, tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource } },
  });
  expect(projectUsagePageCost(response('none'), 'auto').amountUsd).toBeNull();
  expect(projectUsagePageCost(response('provider_reported'), 'auto').amountUsd).toBe(0);
});

it('reprojects source money with its leader when older contributions have no witnessed event counts', () => {
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const cost = { reportedUsd: 0, estimatedUsd: 6, currency: 'USD', costSource: 'pricing_estimate' as const };
  const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1, tokens, cost },
    contributions: [{ id: 'old', observedAtMs: 1, sessionId: 'session', turnId: null, agentId: 'claude',
      modelId: 'priced-model', machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
      sourceContext: { path: 'runtime', execution: 'happier' }, tokens, cost }],
    engineTimeline: [{ bucketStartMs: 0, bucketEndMs: 10, leaders: [{ key: 'claude', eventCount: 1, tokens, cost,
      sources: [{ source: 'runtime', path: 'runtime', execution: 'happier', eventCount: 1, tokens, cost }] }] }],
  });
  const result = repriceUsageAnalyticsResponse(response, { v: 1,
    models: { 'priced-model': { inputUsdPerMillion: 9, outputUsdPerMillion: 0 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'fixture', fetchStatus: 'ready' },
  });
  const page = projectUsagePageCost(UsageAnalyticsQueryResponseSchema.parse(result), 'auto');
  const leader = page.accounting.engineTimeline![0]!.leaders[0]!;
  expect(page.amountUsd).toBe(9);
  expect(resolveUsageCostBasis(leader.cost!, 'auto')?.amountUsd).toBe(9);
  expect(resolveUsageCostBasis(leader.sources![0]!.cost, 'auto')?.amountUsd).toBe(9);
  expect(leader.sources![0]!.cost.estimatedUsd).toBe(6);
});

it('does not expose stale aggregate money when a selected API-equivalent bucket is partly unpriced', () => {
  const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
  const cost = { reportedUsd: 3, estimatedUsd: 0, apiEquivalentUsd: 9, currency: 'USD' };
  const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 2, tokens, cost },
    series: [{ bucketStartMs: 0, bucketEndMs: 10, eventCount: 2, tokens, cost }],
    contributions: [cost, { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' }].map((cost, index) => ({
      id: String(index), observedAtMs: index, eventCount: 1, sessionId: 'session', turnId: null,
      agentId: 'claude', modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens, cost,
    })),
  });
  const page = projectUsagePageCost(response, 'api_equivalent');
  expect(page.amountUsd).toBeNull();
  expect(resolveUsageCostBasis(page.accounting.series![0]!.cost, 'api_equivalent')).toBeNull();
});
