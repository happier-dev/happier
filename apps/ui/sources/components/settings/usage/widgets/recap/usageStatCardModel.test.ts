import { describe, expect, it, vi } from 'vitest';
import {
  UsageRecapComposeResultSchema,
  usageRecapImageFileName,
  type UsageRecapComposeResult,
} from '@happier-dev/protocol';

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

/** Composed exactly as the canonical composer would for the given selection (the schema enforces its manifest). */
function composed(
  selectedFields: Extract<UsageRecapComposeResult, { kind: 'composed' }>['selectedFields'],
  facts: Extract<UsageRecapComposeResult, { kind: 'composed' }>['facts'],
) {
  const result = UsageRecapComposeResultSchema.parse({
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
  });
  if (result.kind !== 'composed') throw new Error('fixture');
  return result;
}

describe('private stat card model', () => {
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
    expect(model.mix.map((row) => row.label)).toEqual([null, null]);
    expect(model.mix.map((row) => Math.round(row.share * 100))).toEqual([
      63, 37,
    ]);
    expect(model.stats.map((stat) => stat.id)).toEqual([
      'activeDays',
      'agentHours',
      'maximumConcurrency',
    ]);
    expect(model.stats.map((stat) => stat.value)).toEqual(['61', '967 h', '6']);
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
        ],
      },
    });
    const model = buildUsageStatCardModel(result);
    expect(model.mix.map((row) => row.label)).toEqual(['Claude', 'Codex']);
    const money = model.stats.filter((stat) => stat.id === 'dollars');
    expect(money.map((stat) => stat.label)).toEqual([
      'usage.board.recap.money_api_equivalent',
      'usage.board.recap.money_unpriced',
    ]);
    expect(money[0]!.value).toMatch(/1,555/);
    expect(money[1]!.value).not.toMatch(/\$|0\.00/);
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
