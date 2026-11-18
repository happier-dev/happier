import { createStoredReadSchema } from '../../../json/storedReadSchema.js';
import { readRecord } from '../../../inputs/inputRecords.js';
import { ReviewSettleRoundInputV1Schema } from '../../../reviews/reviewRoundActionsV1.js';
import type { ReviewRoundBindingV1 } from '../../../reviews/reviewArtifactV1.js';
import type { ReviewReviewerOutcomeV1 } from '../../../reviews/reviewPublicationEvidence.js';
import { ReviewStartTerminalValueV1Schema } from '../../specs/executionRunCompletion.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from '../types.js';

/** Collect only retained Review receipts and ordinary collect_outcomes envelopes. */
function collectReviewRoundOutcomes(input: Readonly<{
  reviewRound: ReviewRoundBindingV1;
  reviewerResults: readonly unknown[];
}>): ReviewReviewerOutcomeV1[] {
  const outcomes: ReviewReviewerOutcomeV1[] = [];
  const pending = [...input.reviewerResults];
  const terminalSchema = createStoredReadSchema(ReviewStartTerminalValueV1Schema);
  for (let index = 0; index < pending.length; index++) {
    const value = pending[index];
    if (Array.isArray(value)) { pending.push(...value); continue; }
    const terminal = terminalSchema.safeParse(value);
    if (terminal.success) {
      const binding = terminal.data.reviewRound;
      if (binding?.reviewId === input.reviewRound.reviewId && binding.roundOrdinal === input.reviewRound.roundOrdinal) {
        outcomes.push(...terminal.data.perEngineOutcome);
      }
      continue;
    }
    const results = readRecord(readRecord(value)?.results);
    if (results) pending.push(...Object.values(results));
  }
  return outcomes;
}

export async function dispatchReviewSettlementAction(input: Readonly<{
  deps: ActionExecutorDeps; ctx: ActionExecutorContext; data: unknown;
}>): Promise<ActionExecuteResult> {
  const parsed = ReviewSettleRoundInputV1Schema.parse(input.data);
  const records = input.deps.reviewRecords?.(input.ctx);
  if (!records) return { ok: false, errorCode: 'review_record_unavailable', error: 'review_record_unavailable' };
  const caller = input.ctx.actionCaller;
  if (caller?.kind !== 'workflowRun') {
    return { ok: false, errorCode: 'invalid_parameters', error: 'workflow_run_required' };
  }
  await records.settle({ ...parsed.reviewRound, outcome: 'completed',
    reviewerOutcomes: collectReviewRoundOutcomes(parsed), finishedAt: Date.now(),
    runs: [{ kind: 'workflow', runId: caller.runId }], signal: input.ctx.signal });
  return { ok: true, result: parsed.reviewRound };
}
