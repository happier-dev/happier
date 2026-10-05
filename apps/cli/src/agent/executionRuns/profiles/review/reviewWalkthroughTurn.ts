import {
  ScmComparisonSchema,
  type ScmDiffSummaryReviewProvenance,
} from '@happier-dev/protocol';
import type { ExecutionRunProfileStartParams } from '../ExecutionRunIntentProfile';
import { readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { buildDiffSummaryPrompt } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/buildDiffSummaryPrompt';
import { planDiffSummaryAnalysis } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/advanceDiffSummaryAnalysis';
import { ScmDiffSummaryProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/ScmDiffSummaryProfile';
import { readOrCreateSavedScmResult, readScmDiffSummaryIntent } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/publishSavedScmDiffSummaryTurn';
import { scmDiffSummaryResultStore } from '../../tasks/scmDiffSummary/results/resultStore';
import { collectReviewFindingCitations, presentReviewFindingCitations, findingCitationInstructions } from './reviewFindingCitations';

export { readReviewNarration } from './reviewNarrationContext';

/** Prepare an output turn for the incumbent reviewer, using U2/U3 admission and storage. */
export async function prepareReviewWalkthroughTurn(params: Readonly<{
  start: ExecutionRunProfileStartParams;
  comparisonId: string;
  provenance: ScmDiffSummaryReviewProvenance;
  findingsContext: string;
}>) {
  const original = readScmDiffSummaryIntent(params.start.intentInput);
  const cwd = typeof original.cwd === 'string' ? original.cwd : undefined;
  if (!cwd) throw new Error('The review has no captured repository scope');
  const captured = await readCapturedScmComparison({ cwd, comparisonId: params.comparisonId,
    ...(params.start.sessionId ? { sessionId: params.start.sessionId } : {}) });
  const current = typeof original.resultId === 'string' ? await scmDiffSummaryResultStore.read({
    cwd, ...(params.start.sessionId ? { sessionId: params.start.sessionId } : {}), resultId: original.resultId,
  }) : null;
  if (current && !current.success) throw new Error(current.error);
  const patch = await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId: params.start.sessionId,
    request: { ...params.start, intent: 'scm_diff_summary', intentInput: {
      cwd, source: captured.comparison.source, comparisonId: captured.comparison.id, outputs: ['walkthrough'],
      ...(current?.success ? { resultId: current.result.resultId, expectedRevision: current.result.revision } : {}),
    } } });
  const input = readScmDiffSummaryIntent(patch?.intentInput);
  const preparedStart: ExecutionRunProfileStartParams = { ...params.start, intentInput: {
    ...original, ...input, reviewNarration: { ...readScmDiffSummaryIntent(original.reviewNarration),
      phase: 'writing', provenance: params.provenance },
  } };
  return prepareSavedReviewWalkthroughInput(preparedStart, params.provenance, params.findingsContext);
}

/** The already captured single-review path never starts another native Run. */
export async function prepareSavedReviewWalkthroughInput(start: ExecutionRunProfileStartParams,
  provenance: ScmDiffSummaryReviewProvenance, findingsContext: string) {
  const { scmAnalysis: _previousAnalysis, ...input } = readScmDiffSummaryIntent(start.intentInput);
  const comparison = ScmComparisonSchema.parse(input.comparison);
  const saved = await readOrCreateSavedScmResult(start);
  if (saved.result.output.runId && saved.result.output.runId !== start.runId) {
    throw new Error('The saved review generator was replaced');
  }
  if (!saved.result.output.runId) {
    const bound = await scmDiffSummaryResultStore.bindRun({ ...saved.scope, expectedRevision: saved.result.revision,
      runId: start.runId, ...(saved.result.generator ? { generator: saved.result.generator } : {}) });
    if (!bound.success) throw new Error(bound.error);
    saved.result = bound.result;
  }
  const localId = `review-walkthrough:${start.runId}:${saved.result.revision}`;
  const narration = { ...readScmDiffSummaryIntent(input.reviewNarration), provenance, findingsContext };
  const reviewFindingCitations = collectReviewFindingCitations(narration, findingsContext);
  const begun = await scmDiffSummaryResultStore.beginInput({
    ...saved.scope, inputId: localId, expectedRevision: saved.result.revision, outputs: ['walkthrough'],
    reviewFindingCitations,
  });
  if (!begun.success) throw new Error(begun.error);
  const narrativeInstructions = [
    provenance.narrationMode === 'continued_review'
      ? 'Continue this review Run by writing the walkthrough. The findings were already published. Do not repeat the review.'
      : 'Write a walkthrough seeded from the published review findings. You are reading the diffs, not reviewing them.',
    'Use the latest review provenance supplied by the host input context.', findingCitationInstructions,
    (() => { try { return JSON.stringify(presentReviewFindingCitations(JSON.parse(findingsContext), reviewFindingCitations)); }
      catch { return findingsContext; } })(),
  ].join('\n\n');
  const instructions = buildDiffSummaryPrompt({ comparison,
    metadata: saved.result.output.metadata!, outputs: ['walkthrough'],
    files: comparison.inventory.files.map(file => ({ path: file.path, changeKind: file.changeKind,
      unifiedDiff: file.evidence.unifiedDiff, ...(file.binary !== null ? { binary: file.binary } : {}),
      ...(file.evidence.state === 'unavailable' ? { description: file.evidence.reason } : {}) })),
    instructions: narrativeInstructions,
  });
  const planned = planDiffSummaryAnalysis({ comparison, metadata: saved.result.output.metadata!, outputs: ['walkthrough'],
    prompt: instructions, instructions: narrativeInstructions,
    contextWindowTokens: typeof input.scmContextWindowTokens === 'number' ? input.scmContextWindowTokens : undefined });
  if (planned) planned.state.expectedInputId = localId;
  return { instructions: planned?.instructions ?? instructions, localId, intentInput: { ...input, resultId: saved.result.resultId,
    instructions: narrativeInstructions,
    ...(planned ? { scmAnalysis: planned.state } : {}),
    expectedRevision: saved.result.revision, outputs: ['walkthrough'],
    reviewNarration: { ...narration, phase: 'writing', reviewFindingCitations },
  } };
}
