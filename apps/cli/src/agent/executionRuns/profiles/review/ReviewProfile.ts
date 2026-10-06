import { REVIEW_SCM_SCOPE_INPUT_KEY } from '@happier-dev/protocol/reviews/reviewStart';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import type { ScmDiffSummaryReviewProvenance } from '@happier-dev/protocol';

import type { ExecutionRunIntentProfile } from '../ExecutionRunIntentProfile';
import { buildReviewGuidanceBlock, buildStandardReviewPrompt } from '../../../reviews/prompt/buildStandardReviewPrompt';
import { normalizeReviewOutput } from '../../../reviews/normalize/normalizeReviewOutput';
import { stripTrailingJsonObjectFromText } from '../shared/stripTrailingJsonObjectFromText';
import { resolveReviewScmScope } from '../../../reviews/scope/resolve';
import { readCapturedScmComparison } from '@/scm/comparisons/captureScmComparison';
import { ScmDiffSummaryProfile } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/ScmDiffSummaryProfile';
import { readScmDiffSummaryIntent } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/publishSavedScmDiffSummaryTurn';
import { prepareSavedReviewWalkthroughInput, readReviewNarration } from './reviewWalkthroughTurn';
import { scmDiffSummaryResultStore } from '../../tasks/scmDiffSummary/results/resultStore';
import { readRetainedReviewFindings } from '../../../reviews/normalize/readRetainedReviewFindings';
import { presentScmDiffSummaryModelContext } from '@/agent/runtime/bridges/executionRun/kinds/scmDiffSummary/presentScmDiffSummaryModelContext';

function requestsWalkthrough(input: unknown) {
  const outputs = readScmDiffSummaryIntent(input).outputs;
  return Array.isArray(outputs) && outputs.includes('walkthrough');
}

function readIntentInputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

export const ReviewProfile: ExecutionRunIntentProfile = {
  intent: 'review',
  supportsDetached: true,
  transcriptMaterialization: 'full',
  emitFinalSidechainMessageWhenStreamed: true,
  prepareStartParams: async ({ request, cwd, sessionId, contextWindowTokens }) => {
    const existing = readIntentInputRecord(request.intentInput);
    delete existing.scmContextWindowTokens;
    delete existing.reviewNarration;
    delete existing.comparison;
    delete existing.metadata;
    delete existing.resultGenerator;
    delete existing.resultBaseRevision;
    const scmReviewScope = await resolveReviewScmScope({
      cwd,
      intentInput: existing,
    });
    // The comparison identity is the sole caller selector; reread its machine evidence.
    const captured = typeof existing.comparisonId === 'string'
      ? await readCapturedScmComparison({ cwd, comparisonId: existing.comparisonId, ...(sessionId ? { sessionId } : {}) }) : null;
    if (requestsWalkthrough(existing) && (!captured || !sessionId)) throw new Error('Review narration requires a captured Session comparison');
    const analysis = requestsWalkthrough(existing) && captured ? await ScmDiffSummaryProfile.prepareStartParams!({ cwd, sessionId,
      request: { ...request, intent: 'scm_diff_summary', intentInput: {
        cwd, source: captured.comparison.source, comparisonId: captured.comparison.id, outputs: ['walkthrough'],
        cachePolicy: { mode: 'bypass' },
      } } }) : null;
    return {
      intentInput: {
        ...existing,
        ...(captured ? { comparisonId: captured.comparison.id, comparison: captured.comparison,
          metadata: captured.metadata, cwd, source: captured.comparison.source } : {}),
        ...(analysis ? readScmDiffSummaryIntent(analysis.intentInput) : {}),
        ...(contextWindowTokens ? { scmContextWindowTokens: contextWindowTokens } : {}),
        [REVIEW_SCM_SCOPE_INPUT_KEY]: scmReviewScope,
      },
    };
  },
  buildPrompt: (params) => {
    if (readReviewNarration(params.intentInput)) return params.instructions;
    const prompt = buildStandardReviewPrompt({ instructions: params.instructions, intentInput: params.intentInput });
    const comparison = ScmComparisonSchema.safeParse(readScmDiffSummaryIntent(params.intentInput).comparison);
    return comparison.success ? `${prompt}\n\nReview only this captured comparison, including its explicit unavailable evidence.\n${JSON.stringify(presentScmDiffSummaryModelContext(comparison.data, comparison.data))}` : prompt;
  },
  onStarted: (params) => requestsWalkthrough(params.start.intentInput) ? ScmDiffSummaryProfile.onStarted!(params) : null,
  onBeforeRetainedInput: (params) => requestsWalkthrough(params.start.intentInput)
    ? ScmDiffSummaryProfile.onBeforeRetainedInput!(params) : Promise.resolve(),
  onRetainedInputAdmitted: (params) => readReviewNarration(params.start.intentInput)
    ? ScmDiffSummaryProfile.onRetainedInputAdmitted!(params) : Promise.resolve(null),
  buildInitialInputContext: (params) => {
    const narration = readReviewNarration(params.start.intentInput);
    if (!narration) return '';
    return ScmDiffSummaryProfile.buildInitialInputContext!(params);
  },
  onTurnComplete: async (params) => {
    if (readReviewNarration(params.start.intentInput)) return ScmDiffSummaryProfile.onTurnComplete!(params);
    const completed = normalizeReviewOutput({ ...params.start, rawText: params.rawText, finishedAtMs: params.finishedAtMs });
    if (!requestsWalkthrough(params.start.intentInput)) return completed;
    const findings = completed.structuredMeta?.kind === 'review_findings.v2'
      ? ReviewFindingsV2Schema.safeParse(completed.structuredMeta.payload) : null;
    const input = readScmDiffSummaryIntent(params.start.intentInput);
    const comparison = ScmComparisonSchema.parse(input.comparison);
    // Findings consumed the initial admitted input, not a walkthrough publication.
    if (typeof input.resultId === 'string') {
      for (const inputId of params.inputIds?.length ? params.inputIds : [`initial:${params.start.runId}`]) {
        await scmDiffSummaryResultStore.abandonInput({ cwd: comparison.repository.rootPath,
          ...(params.start.sessionId ? { sessionId: params.start.sessionId } : {}), resultId: input.resultId, inputId });
      }
    }
    const provenance = { reviewedRuns: [{ runId: params.start.runId, callId: params.start.callId,
      backendId: params.start.backendId, status: completed.status, hasOutput: findings?.success === true,
      reviewOutcome: findings?.success ? findings.data.reviewOutcome ?? 'complete' : 'unavailable', comparisonId: comparison.id }],
      narrationMode: 'continued_review', comparisonFreshness: 'unchanged' } satisfies ScmDiffSummaryReviewProvenance;
    const nextInput = await prepareSavedReviewWalkthroughInput({ ...params.start, intentInput: {
      ...readScmDiffSummaryIntent(params.start.intentInput), reviewNarration: {
        reviewFindings: findings?.success ? [findings.data] : [],
        reviewStatus: completed.status,
      },
    } }, provenance, 'Use the latest published findings and review provenance supplied by the host input context.');
    return { ...completed, nextInput, toolResultMeta: { ...completed.toolResultMeta,
      reviewNarration: { phase: 'writing', resultId: nextInput.intentInput.resultId,
        runId: params.start.runId, ...provenance } } };
  },
  onTurnFailed: (params) => requestsWalkthrough(params.start.intentInput) ? ScmDiffSummaryProfile.onTurnFailed!(params) : null,
  onTerminal: (params) => requestsWalkthrough(params.start.intentInput) ? ScmDiffSummaryProfile.onTerminal!(params) : null,
  computeSidechainStreamText: ({ fullText }) => {
    const stripped = stripTrailingJsonObjectFromText(fullText).trimEnd();
    if (stripped !== String(fullText ?? '').trimEnd()) return stripped;

    // If the model is currently emitting the final JSON object but it's not parseable yet,
    // avoid streaming partial JSON fragments by cutting at the JSON start marker.
    const t = String(fullText ?? '');
    const start = t.trimStart().startsWith('{') ? t.indexOf('{') : t.lastIndexOf('\n{');
    if (start >= 0) {
      const tail = t.slice(start, Math.min(t.length, start + 400));
      if (tail.includes('"summary"') || tail.includes('"findings"') || tail.includes('"walkthrough"')) {
        return t.slice(0, start).trimEnd();
      }
    }
    return t;
  },
  buildInvalidOutputRepairPrompt: ({ start, rawText }) => readReviewNarration(start.intentInput)
    ? ScmDiffSummaryProfile.buildInvalidOutputRepairPrompt!({ start, rawText }) : [
    'Your previous response did not include the required final JSON object.',
    'If you have already completed the review, convert your conclusions into the required JSON now.',
    'If you have not yet inspected the workspace or gathered enough evidence, continue the review first using the available read-only tools, then return ONLY valid JSON (parsable by JSON.parse).',
    'Do not wrap it in markdown code fences. Do not include any extra text before or after the JSON.',
    buildReviewGuidanceBlock(),
    '',
    'Content to convert:',
    rawText,
  ].filter((line) => line.length > 0).join('\n'),
  listAvailableActionIds: ({ structuredMeta, start }) => {
    const findings = readRetainedReviewFindings({ ...start, structuredMeta: structuredMeta ?? undefined });
    if (!findings) return [];
    const input = readScmDiffSummaryIntent(start.intentInput);
    return [
      'review.triage',
      ...(start.retentionPolicy === 'resumable' && !readReviewNarration(start.intentInput) ? ['review.follow_up'] : []),
      ...(typeof input.comparisonId === 'string' ? ['review.walkthrough'] : []),
      ...(typeof input.resultId === 'string' ? ['review.explain_findings'] : []),
    ];
  },
  onBoundedComplete: ({ start, rawText, finishedAtMs }) =>
    normalizeReviewOutput({
      runId: start.runId,
      callId: start.callId,
      sidechainId: start.sidechainId,
      backendId: start.backendId,
      backendTarget: start.backendTarget,
      retentionPolicy: start.retentionPolicy,
      startedAtMs: start.startedAtMs,
      finishedAtMs,
      rawText,
      intentInput: start.intentInput,
    }),
  // review.triage (a ReviewComment transition) and review.follow_up (a resumed run) are handled by
  // the execution-run runtime; the review's result is never rewritten by an action.
};
