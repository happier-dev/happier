import { describe, expect, it } from 'vitest';
import { ScmDiffSummaryGenerateOutputSchema } from '@happier-dev/protocol';
import { summarizeScmDiffSummarySevenDayCost } from './scmDiffSummarySevenDayCost';

describe('saved change explanation cost projection', () => {
  it('reads only retained cost, not the comparison or saved reading body', () => {
    const untilMs = 1_000;
    const payload = { cost: { estimatedUsd: 0.25 },
      get comparison(): never { throw new Error('Cost projection read comparison evidence'); },
      get outputs(): never { throw new Error('Cost projection read saved prose'); } };
    expect(summarizeScmDiffSummarySevenDayCost([{ intent: 'scm_diff_summary', startedAtMs: untilMs,
      structuredMeta: { kind: 'scm_diff_summary.v1', payload } }], untilMs))
      .toMatchObject({ status: 'partial', estimatedUsd: 0.25, pricedRunCount: 1, unpricedRunCount: 0 });
  });

  it('sums only actual recent execution records and discloses incomplete cost coverage', () => {
    const untilMs = 10 * 24 * 60 * 60 * 1000;
    const payload = (estimatedUsd?: number) => ({ kind: 'scm_diff_summary.v1', payload: { ...ScmDiffSummaryGenerateOutputSchema.parse({
      success: true, summaryMarkdown: 'Summary', sourceKey: 'comparison', metadata: { sourceKey: 'comparison', source: { kind: 'workingTree' } },
      ...(estimatedUsd === undefined ? {} : { cost: { estimatedUsd } }),
    }), retiredOutput: true, ...(estimatedUsd === undefined ? {} : { cost: { estimatedUsd, retiredCost: true } }) } });
    expect(summarizeScmDiffSummarySevenDayCost([
      { intent: 'scm_diff_summary', startedAtMs: untilMs - 100, structuredMeta: payload(0.12) },
      { intent: 'scm_diff_summary', startedAtMs: untilMs - 200, structuredMeta: payload(0) },
      { intent: 'scm_diff_summary', startedAtMs: untilMs - 300, structuredMeta: payload() },
      { intent: 'scm_diff_summary', startedAtMs: 1, structuredMeta: payload(100) },
      { intent: 'review', startedAtMs: untilMs - 100, structuredMeta: payload(100) },
    ], untilMs)).toEqual({ status: 'partial', estimatedUsd: 0.12, pricedRunCount: 2, unpricedRunCount: 1,
      sinceMs: 3 * 24 * 60 * 60 * 1000, untilMs });
    expect(summarizeScmDiffSummarySevenDayCost([], untilMs)).toEqual({ status: 'unavailable',
      pricedRunCount: 0, unpricedRunCount: 0, sinceMs: 3 * 24 * 60 * 60 * 1000, untilMs });
  });
});
