import { EXECUTION_RUN_KIND_BY_INTENT } from '@happier-dev/protocol/execution/runs/startRequest';
import { ScmDiffSummaryCostMetadataSchema } from '@happier-dev/protocol/scm/diffSummary';
import type { ScmDiffSummarySevenDayCost } from '@happier-dev/protocol';
import type { RetainedExecutionRunRecord } from '@/agent/runtime/bridges/executionRun/retainedState';

type CostRecord = Pick<RetainedExecutionRunRecord['state'], 'intent' | 'startedAtMs' | 'finishedAtMs' | 'structuredMeta'>;
function sevenDayCostSince(untilMs: number): number {
  return Math.max(0, untilMs - 7 * 24 * 60 * 60 * 1000);
}

/** Scope admission and cost projection consume the same retained-record window. */
export function isScmDiffSummarySevenDayCostRecord(record: Pick<CostRecord, 'intent' | 'startedAtMs' | 'finishedAtMs'>, untilMs: number): boolean {
  const occurredAtMs = record.finishedAtMs ?? record.startedAtMs;
  return record.intent === 'scm_diff_summary' && occurredAtMs >= sevenDayCostSince(untilMs) && occurredAtMs <= untilMs;
}

/** Retained Run projections are not a complete historical cost ledger. */
export function summarizeScmDiffSummarySevenDayCost(records: readonly CostRecord[], untilMs: number): ScmDiffSummarySevenDayCost {
  const sinceMs = sevenDayCostSince(untilMs);
  const recent = records.filter(record => isScmDiffSummarySevenDayCostRecord(record, untilMs));
  let estimatedUsd = 0;
  let pricedRunCount = 0;
  for (const record of recent) {
    if (record.structuredMeta?.kind !== EXECUTION_RUN_KIND_BY_INTENT.scm_diff_summary) continue;
    const payload = record.structuredMeta.payload;
    const metadata = payload && typeof payload === 'object' && !Array.isArray(payload) && 'cost' in payload
      ? ScmDiffSummaryCostMetadataSchema.safeParse(payload.cost) : null;
    const cost = metadata?.success ? metadata.data.estimatedUsd : undefined;
    if (cost === undefined) continue;
    estimatedUsd += cost;
    pricedRunCount += 1;
  }
  // One retained projection may represent only the latest turn and old Runs can be retired.
  // Never label this real-record subtotal a complete seven-day charge total.
  return { status: pricedRunCount ? 'partial' : 'unavailable', ...(pricedRunCount ? { estimatedUsd } : {}),
    pricedRunCount, unpricedRunCount: recent.length - pricedRunCount, sinceMs, untilMs };
}
