import type { ScmComparison } from './comparison.js';
import { isScmCommitPlanApplicationLocked } from './diffSummaryCommitPlan.js';
import { buildScmReviewScopeId } from './comparisonOccurrences.js';
import {
  ScmDiffSummaryResultClearInputSchema, ScmDiffSummaryResultDeleteResponseSchema,
  ScmDiffSummaryResultResponseSchema, ScmDiffSummaryResultListResponseSchema,
  type ScmDiffSummaryResultClearInput, type ScmDiffSummaryResultClearResponse,
  type ScmDiffSummarySavedResultReference,
} from './diffSummaryResult.js';
import { ScmReviewedMarkResponseSchema, type ScmReviewedMarksResetInput } from './reviewedMarks.js';

/** Shared Clear owner. Adapters supply the admitted Machine and personal Account boundaries. */
export async function executeScmDiffSummaryClear(params: Readonly<{
  input: ScmDiffSummaryResultClearInput;
  assertCurrent: () => void;
  list: () => Promise<unknown>;
  read: (reference: ScmDiffSummarySavedResultReference) => Promise<unknown>;
  delete: (reference: ScmDiffSummarySavedResultReference) => Promise<unknown>;
  clearReviewedMarks: (comparison: ScmComparison, reset: ScmReviewedMarksResetInput) => Promise<unknown>;
}>): Promise<ScmDiffSummaryResultClearResponse> {
  const input = ScmDiffSummaryResultClearInputSchema.parse(params.input);
  const deleted: Extract<ScmDiffSummaryResultClearResponse, { success: true }>['deleted'] = [];
  const failures: Extract<ScmDiffSummaryResultClearResponse, { success: true }>['failures'] = [];
  if (input.results.length === 0) return { success: true, deleted, failures };
  // Use the existing Machine inventory once. Marks belong to its comparison
  // scope, so a refused or unselected surviving result must retain them.
  const remaining = new Map<string, string>();
  const scopeCounts = new Map<string, number>();
  try {
    params.assertCurrent();
    const inventory = ScmDiffSummaryResultListResponseSchema.parse(await params.list());
    params.assertCurrent();
    if (!inventory.success) return inventory;
    for (const item of inventory.results) {
      const scope = buildScmReviewScopeId({ repositoryRootPath: item.cwd, source: item.source });
      remaining.set(item.resultId, scope);
      scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
    }
  } catch (error) {
    return { success: false, errorCode: 'result_unavailable',
      error: error instanceof Error ? error.message : 'The saved result inventory is unavailable.' };
  }
  const cleanup = new Map<string, { comparison: ScmComparison; item: ScmDiffSummarySavedResultReference }>();
  for (const item of input.results) {
    let comparison: ScmComparison;
    try {
      params.assertCurrent();
      const observed = ScmDiffSummaryResultResponseSchema.parse(await params.read(item));
      params.assertCurrent();
      if (!observed.success) { failures.push({ ...observed, resultId: item.resultId }); continue; }
      const saved = observed.result;
      if (saved.resultId !== item.resultId || saved.output.comparison?.id !== item.comparisonId) {
        failures.push({ resultId: item.resultId, success: false, errorCode: 'invalid_edit', error: 'The listed comparison does not identify this saved result.' });
        continue;
      }
      if (saved.revision !== item.expectedRevision) {
        failures.push({ resultId: item.resultId, success: false, errorCode: 'revision_conflict', error: 'The saved result changed before Clear.', latestRevision: saved.revision });
        continue;
      }
      if (isScmCommitPlanApplicationLocked(saved.application)) {
        failures.push({ resultId: item.resultId, success: false, errorCode: 'application_locked', error: 'Resolve the accepted commit application before clearing its result.' });
        continue;
      }
      comparison = saved.output.comparison;
      // The Machine still rechecks revision/application under its deletion lock.
      const receipt = ScmDiffSummaryResultDeleteResponseSchema.parse(await params.delete(item));
      if (!receipt.success) { failures.push({ ...receipt, resultId: item.resultId }); continue; }
      if (receipt.resultId !== item.resultId || receipt.comparisonId !== comparison.id) {
        throw new Error('The Machine deletion receipt does not identify the selected saved result.');
      }
      // Preserve the irreversible receipt before cancellation/currentness or Account cleanup.
      deleted.push(receipt);
      const scope = buildScmReviewScopeId({ repositoryRootPath: comparison.repository.rootPath, source: comparison.source });
      const listedScope = remaining.get(item.resultId);
      if (listedScope) {
        remaining.delete(item.resultId);
        scopeCounts.set(listedScope, (scopeCounts.get(listedScope) ?? 1) - 1);
      }
      cleanup.set(scope, { comparison, item });
    } catch (error) {
      failures.push({ resultId: item.resultId, success: false, errorCode: 'result_unavailable',
        error: error instanceof Error ? error.message : 'The saved result is unavailable.' });
      continue;
    }
  }
  for (const [scope, { comparison, item }] of cleanup) {
    if ((scopeCounts.get(scope) ?? 0) > 0) continue;
    const reset: ScmReviewedMarksResetInput = { v: 2, cwd: comparison.repository.rootPath,
      comparisonId: comparison.id, source: comparison.source, reset: true,
      ...(item.sessionId ? { sessionId: item.sessionId } : {}) };
    try {
      params.assertCurrent();
      const response = ScmReviewedMarkResponseSchema.parse(await params.clearReviewedMarks(comparison, reset));
      if (!response.success) throw new Error(response.error);
    } catch (error) {
      failures.push({ success: false, errorCode: 'reviewed_marks_cleanup_failed', resultId: item.resultId,
        comparisonId: comparison.id, resultDeleted: true,
        error: error instanceof Error ? error.message : 'The saved result was deleted, but its personal marks could not be cleared.',
        retry: { actionId: 'scm.diffSummary.reviewed.unmark', input: reset } });
    }
  }
  return { success: true, deleted, failures };
}
