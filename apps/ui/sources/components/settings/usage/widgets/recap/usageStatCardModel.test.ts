import { describe, expect, it, vi } from 'vitest';
import type { UsageRecapComposeResult } from '@happier-dev/protocol/usage/usageRecap';

vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
);

const tokens = {
  input: 900_000_000,
  output: 300_000_000,
  reasoning: 0,
  cacheRead: 600_000_000,
  cacheWrite: 100_000_000,
  total: 1_900_000_000,
};
const periodStart = Date.UTC(2026, 6, 1);
const periodEnd = Date.UTC(2026, 8, 30);

/** Typed selected-fact boundary fixture; composed/schema/visible checks live in UsageStatCard.test.tsx. */
function composed(
  selectedFields: Extract<UsageRecapComposeResult, { kind: 'composed' }>['selectedFields'],
  facts: Extract<UsageRecapComposeResult, { kind: 'composed' }>['facts'],
) {
  const result: Extract<UsageRecapComposeResult, { kind: 'composed' }> = {
    kind: 'composed',
    v: 1,
    style: 'daybreak',
    format: 'square',
    selectedFields,
    unavailableFields: [],
    period: {
      startMs: periodStart,
      endMs: periodEnd,
      timeZoneOffsetMinutes: 120,
    },
    asOfMs: periodEnd,
    coverage: {
      accounting: null,
      sourceCoverage: [],
      sourceStatuses: [],
      pending: false,
    },
    facts,
  };
  return result;
}

describe('private stat card model', () => {
  it('renders public shares and independent figures without inventing private amounts or elapsed time', async () => {
    const { buildUsageStatCardModel } = await import('./usageStatCardModel');
    const { UsageRecapComposeResultSchema } = await import('@happier-dev/protocol/usage/usageRecap');
    const publicResult = UsageRecapComposeResultSchema.parse({ ...composed(['agentMix', 'parallel', 'rhythm', 'work', 'highlights'], {}),
      source: 'public_profile', publicSnapshot: { v: 1, computedAtMs: periodEnd,
        period: { startMs: periodStart, endMs: periodEnd, timeZoneOffsetMinutes: 120 },
        coverage: { status: 'partial', method: 'runtime' }, fieldCoverage: {},
        facts: { peakParallel: 4, mergedPrs: 2, highlights: [{ kind: 'active_days', count: 3 }, { kind: 'peak_parallel', count: 4 }],
          calendar: [{ date: '2026-07-01', level: 3 }, { date: '2026-07-02', level: null }],
          agentMix: [{ agentId: 'codex', share: 0.75, coverage: { status: 'partial', method: 'runtime' } }] } } });
    if (publicResult.kind !== 'composed') throw new Error('Expected composed fixture');
    const model = buildUsageStatCardModel(publicResult);
    expect(model.headline).toBeNull();
    expect(model.mixGroups[0]?.rows).toMatchObject([{ share: 0.75, agentId: 'codex' }]);
    expect(model.mixGroups[0]?.totalTokens).toBeNull();
    expect(model.stats.map(stat => stat.id)).toEqual(['maximumConcurrency', 'mergedPrs', 'activeDays']);
    expect(model.stats.find(stat => stat.id === 'activeDays')).toMatchObject({ value: '3' });
    expect(model.days).toEqual([3, 0]);
    expect(JSON.stringify(model)).not.toMatch(/agentHours|dollars|unionElapsed/);
  });
  it('does not promote raw whole-report money into unavailable scoped spend or repeat a Work highlight', async () => {
    const { buildUsageStatCardModel } = await import('./usageStatCardModel');
    const model = buildUsageStatCardModel(composed(['dollars', 'work', 'highlights'], {
      dollars: { basis: 'auto', selected: null, facts: [{ kind: 'reported', amountUsd: 35.61,
        currency: 'USD', tokens, eventCount: 1, asOfMs: periodEnd, complete: false }] },
      work: { linkedOutcomes: 7, allocatedContributions: 7, unallocatedContributions: 0 },
      highlights: [{ kind: 'linked_outcomes', count: 7 }],
    }));
    // An unknown selected total is not drawn as a bare dash: nothing priced is simply absent.
    expect(model.stats.filter(stat => stat.id === 'dollars')).toEqual([]);
    expect(model.stats.filter(stat => stat.id === 'linkedOutcomes' || stat.id === 'highlightOutcomes')).toHaveLength(1);
  });
  it('lets the comparisons lead when the selected total is unknown', async () => {
    const { buildUsageStatCardModel } = await import('./usageStatCardModel');
    const model = buildUsageStatCardModel(composed(['dollars'], {
      dollars: { basis: 'auto', selected: null, facts: [
        { kind: 'estimated', amountUsd: 28.61, currency: 'USD', tokens, eventCount: 2, asOfMs: periodEnd, complete: false },
        { kind: 'unpriced', amountUsd: null, currency: 'USD', tokens, eventCount: 1, asOfMs: periodEnd, complete: false },
      ] },
    }));
    const money = model.stats.filter(stat => stat.id === 'dollars');
    expect(money.map(stat => stat.tier)).toEqual(['comparison', 'comparison']);
    expect(money[0]!.value).toMatch(/28\.61/);
  });
  it('keeps cache-only and highlight-only selections in the card facts', async () => {
    const { buildUsageStatCardModel } = await import('./usageStatCardModel');
    const cache = buildUsageStatCardModel(composed(['cache'], { cache: { readTokens: 12345, writeTokens: 6789 } }));
    expect(cache.headline).toBeNull();
    expect(cache.stats).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'cacheReadTokens', value: '12.3K' }),
      expect.objectContaining({ id: 'cacheWriteTokens', value: '6.8K' }),
    ]));
    const highlights = buildUsageStatCardModel(composed(['highlights'], { highlights: [
      { kind: 'observed_peak', bucketStartMs: periodStart, bucketEndMs: periodStart + 86400000, tokens: 12345 },
      { kind: 'linked_outcomes', count: 7 },
    ] }));
    expect(highlights.stats).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'observedPeak', value: '12.3K' }),
      expect.objectContaining({ id: 'highlightOutcomes', value: '7' }),
    ]));
  });

  it('preserves both selected mixes as separate populations without exposing unselected names', async () => {
    const { buildUsageStatCardModel } = await import('./usageStatCardModel');
    const model = buildUsageStatCardModel(composed(['agentMix', 'modelMix'], {
      agentMix: [{ tokens: 3, events: 1 }, { tokens: 1, events: 1 }],
      modelMix: [{ tokens: 2, events: 1 }, { tokens: 2, events: 1 }],
    }));
    expect(model).toMatchObject({ mixGroups: [
      { kind: 'agentMix', rows: [{ share: 0.75, label: null }, { share: 0.25, label: null }] },
      { kind: 'modelMix', rows: [{ share: 0.5, label: null }, { share: 0.5, label: null }] },
    ] });
  });
  it('shows only the selected facts, never names or dollars that were left off', async () => {
    const { buildUsageStatCardModel } =
      await import('./usageStatCardModel');
    const result = composed(['tokens', 'activeDays', 'agentMix', 'parallel'], {
      tokens,
      activeDays: 61,
      agentMix: [
        { tokens: 1_200_000_000, events: 40 },
        { tokens: 700_000_000, events: 20 },
      ],
      parallel: {
        sumAgentMs: 967 * 3_600_000,
        unionElapsedMs: 300 * 3_600_000,
        maximumConcurrency: 6,
      },
    });
    const model = buildUsageStatCardModel(result);
    expect(model.manifest).toEqual([
      'tokens',
      'activeDays',
      'agentMix',
      'parallel',
    ]);
    expect(model.headline).toEqual({
      value: '1.9B',
      unit: 'usage.board.recap.tokensUnit',
    });
    expect(model.mixGroups[0]!.rows.map((row) => row.label)).toEqual([null, null]);
    expect(model.mixGroups[0]!.rows.map((row) => Math.round(row.share * 100))).toEqual([
      63, 37,
    ]);
    expect(model.stats.map((stat) => stat.id)).toEqual([
      'activeDays',
      'agentHours',
      'maximumConcurrency',
    ]);
    expect(model.stats.map((stat) => stat.value)).toEqual(['61', '967 h', '6']);
    const { usageRecapImageFileName } = await import('@happier-dev/protocol/usage/usageRecap');
    const everything = JSON.stringify(model) + usageRecapImageFileName(result);
    expect(everything).not.toMatch(/\$|USD|Claude|Codex/);
    expect(usageRecapImageFileName(result)).toBe(
      'happier-usage-daybreak-square-20260930.png',
    );
  });

  it('names Agents and shows each money kind separately only when selected, unpriced never as zero', async () => {
    const { buildUsageStatCardModel } = await import('./usageStatCardModel');
    const result = composed(['tokens', 'agentMix', 'names', 'dollars'], {
      tokens,
      agentMix: [
        { tokens: 1_200_000_000, events: 40, name: 'Claude' },
        { tokens: 700_000_000, events: 20, name: 'Codex' },
      ],
      dollars: {
        basis: 'auto',
        selected: { kind: 'api_equivalent', currency: 'USD', amountUsd: 1555 },
        facts: [
          {
            kind: 'api_equivalent',
            currency: 'USD',
            amountUsd: 1555,
            tokens,
            eventCount: 60,
            asOfMs: periodEnd,
            complete: true,
          },
          {
            kind: 'unpriced',
            currency: 'USD',
            amountUsd: null,
            tokens,
            eventCount: 3,
            asOfMs: periodEnd,
            complete: false,
          },
          { kind: 'invoice', currency: 'EUR', amountUsd: 12,
            tokens, eventCount: 1, asOfMs: periodEnd, complete: true },
        ],
      },
    });
    const model = buildUsageStatCardModel(result);
    expect(model.mixGroups[0]!.rows.map((row) => row.label)).toEqual(['Claude', 'Codex']);
    const money = model.stats.filter((stat) => stat.id === 'dollars');
    expect(money.map((stat) => stat.label)).toEqual([
      'usage.board.recap.money_api_equivalent · USD',
      'usage.board.page.factInvoice · EUR',
      'usage.board.recap.money_unpriced · USD',
    ]);
    // The selected total is the one lead; every other money kind is a quieter comparison beneath it.
    expect(money.map((stat) => stat.tier)).toEqual(['lead', 'comparison', 'comparison']);
    expect(money[0]!.value).toMatch(/1,555/);
    expect(money[1]!.value).toContain('€12');
    expect(money[2]!.value).not.toMatch(/\$|0\.00/);
  });

  it('labels the exact composed period, not the time it was opened', async () => {
    const { buildUsageStatCardModel } = await import('./usageStatCardModel');
    const model = buildUsageStatCardModel(composed(['tokens'], { tokens }));
    expect(model.period).toEqual({
      startMs: periodStart,
      endMs: periodEnd,
      timeZoneOffsetMinutes: 120,
    });
    const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    expect(model.periodLabel).toBe(`${date.format(periodStart + 120 * 60_000)} – ${date.format(periodEnd - 1 + 120 * 60_000)}`);
  });
});
