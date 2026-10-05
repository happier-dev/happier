import { ScmDiffSummaryGenerateOutputSchema, type ScmDiffSummarySevenDayCost } from '@happier-dev/protocol';
import type { RetainedExecutionRunRecord } from '@/agent/runtime/bridges/executionRun/retainedState';

type CostRecord = Pick<RetainedExecutionRunRecord['state'], 'intent' | 'startedAtMs' | 'finishedAtMs' | 'structuredMeta'>;
/** Retained Run projections are not a complete historical cost ledger. */
export function summarizeScmDiffSummarySevenDayCost(records: readonly CostRecord[], untilMs: number): ScmDiffSummarySevenDayCost {
  const sinceMs = Math.max(0, untilMs - 7 * 24 * 60 * 60 * 1000);
  const recent = records.filter(record => record.intent === 'scm_diff_summary'
    && (record.finishedAtMs ?? record.startedAtMs) >= sinceMs && (record.finishedAtMs ?? record.startedAtMs) <= untilMs);
  let estimatedUsd = 0;
  let pricedRunCount = 0;
  for (const record of recent) {
    if (record.structuredMeta?.kind !== 'scm_diff_summary.v1') continue;
    const output = ScmDiffSummaryGenerateOutputSchema.safeParse(record.structuredMeta.payload);
    const cost = output.success ? output.data.cost?.estimatedUsd : undefined;
    if (cost === undefined) continue;
    estimatedUsd += cost;
    pricedRunCount += 1;
  }
  // One retained projection may represent only the latest turn and old Runs can be retired.
  // Never label this real-record subtotal a complete seven-day charge total.
  return { status: pricedRunCount ? 'partial' : 'unavailable', ...(pricedRunCount ? { estimatedUsd } : {}),
    pricedRunCount, unpricedRunCount: recent.length - pricedRunCount, sinceMs, untilMs };
}
