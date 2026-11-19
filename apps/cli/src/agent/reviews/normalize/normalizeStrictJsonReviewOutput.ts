import type { BackendTargetRefV1, ExecutionRunRetentionPolicy, ReviewFinding } from '@happier-dev/protocol';
import { ReviewAssumptionSchema } from '@happier-dev/protocol/reviews/ReviewAssumption';
import { ReviewFindingSchema } from '@happier-dev/protocol/reviews/ReviewFinding';
import { ReviewQuestionSchema } from '@happier-dev/protocol/reviews/ReviewQuestion';
import { ReviewQualityV1Schema } from '@happier-dev/protocol/reviews/reviewPublicationEvidence';
import { ReviewCommentProposalsV1Schema } from '@happier-dev/protocol/reviews/comments/proposals';
import { ReviewFindingsV2Schema } from '@happier-dev/protocol/messages/structured/reviewFindingsV2';
import { firstMarkdownProse } from '@happier-dev/protocol/messages/markdownPlainText';
import { z } from '@happier-dev/protocol/zodRuntimePolicy';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm/comparison';

import type {
  ExecutionRunProfileBoundedCompleteResult,
  ExecutionRunStructuredMeta,
} from '../../executionRuns/profiles/ExecutionRunIntentProfile';
import { ReviewFollowUpIntentInputSchema } from '../followUp/reviewFollowUpIntentInput';
import { parseTrailingJsonObject } from '../../executionRuns/profiles/shared/parseTrailingJsonObject';
import { createReviewScopeAttribution } from './scopeAttribution';

function stripOptionalModelNulls(value: unknown, shape: Readonly<Record<string, {
  safeParse(value: unknown): Readonly<{ success: boolean }>;
}>>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = { ...value } as Record<string, unknown>;
  for (const [key, schema] of Object.entries(shape)) {
    if (record[key] === null && schema.safeParse(undefined).success) delete record[key];
  }
  return record;
}

function parseModelFinding(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ReviewFindingSchema.safeParse(value);
  // Persisted references are attached only by the host ReviewComment owner.
  const { comment: _modelComment, scopeAttribution: _modelScopeAttribution, ...finding } = value as Record<string, unknown>;
  // Models use an empty patch to report that no replacement was proposed.
  if (finding.patch === '') delete finding.patch;
  return ReviewFindingSchema.safeParse(stripOptionalModelNulls(finding, ReviewFindingSchema.shape));
}

function readAdmittedReviewComparison(input: Record<string, unknown>) {
  const comparison = ScmComparisonSchema.safeParse(input.comparison);
  return comparison.success && comparison.data.id === input.comparisonId ? comparison.data : undefined;
}

const ReviewFindingsContentV2Schema = z.extend(z.omit(ReviewFindingsV2Schema, { runRef: true }), {
  reviewOutcome: z.nonoptional(ReviewFindingsV2Schema.shape.reviewOutcome),
});
export type ReviewFindingsContentV2 = z.infer<typeof ReviewFindingsContentV2Schema>;

/** Normalize actual review content independently of the executing run or Session. */
export function normalizeParsedReviewContent(params: Readonly<{
  value: unknown;
  intentInput?: unknown;
  generatedAtMs: number;
}>): ReviewFindingsContentV2 | null {
  const parsedRecord = params.value && typeof params.value === 'object' && !Array.isArray(params.value)
    ? params.value as Record<string, unknown> : null;
  const summaryRaw = parsedRecord?.summary;
  const overviewMarkdownRaw = parsedRecord?.overviewMarkdown;
  const findingsRaw = parsedRecord?.findings;
  const questionsRaw = parsedRecord?.questions;
  const assumptionsRaw = parsedRecord?.assumptions;
  const proposedCommentsRaw = parsedRecord?.proposedComments;
  const input = params.intentInput && typeof params.intentInput === 'object' && !Array.isArray(params.intentInput)
    ? params.intentInput as Record<string, unknown> : {};
  const admittedComparison = readAdmittedReviewComparison(input);
  const scopeAttribution = createReviewScopeAttribution(admittedComparison);

  if (!parsedRecord || typeof summaryRaw !== 'string' || summaryRaw.trim().length === 0 || !Array.isArray(findingsRaw)) {
    return null;
  }

  const findings: ReviewFinding[] = [];
  for (const item of findingsRaw) {
    const parsedFinding = parseModelFinding(item);
    if (!parsedFinding.success) {
      return null;
    }
    findings.push({ ...parsedFinding.data, scopeAttribution: scopeAttribution(parsedFinding.data) });
  }

  const questions = Array.isArray(questionsRaw)
    ? questionsRaw.flatMap((item) => {
      const parsedQuestion = ReviewQuestionSchema.safeParse(stripOptionalModelNulls(item, ReviewQuestionSchema.shape));
      return parsedQuestion.success ? [parsedQuestion.data] : [];
    })
    : [];
  const assumptions = Array.isArray(assumptionsRaw)
    ? assumptionsRaw.flatMap((item) => {
      const parsedAssumption = ReviewAssumptionSchema.safeParse(stripOptionalModelNulls(item, ReviewAssumptionSchema.shape));
      return parsedAssumption.success ? [parsedAssumption.data] : [];
    })
    : [];
  const proposedComments = typeof proposedCommentsRaw === 'undefined'
    ? undefined
    : ReviewCommentProposalsV1Schema.safeParse(proposedCommentsRaw);
  if (proposedComments && !proposedComments.success) {
    return null;
  }

  const comparison = input.comparison && typeof input.comparison === 'object'
    ? input.comparison as Record<string, unknown> : {};
  const inventory = comparison.inventory && typeof comparison.inventory === 'object'
    ? comparison.inventory as Record<string, unknown> : {};
  const limits = parsedRecord.limits && typeof parsedRecord.limits === 'object'
    ? parsedRecord.limits as Record<string, unknown> : {};
  // A findings array reports findings, not whether inspection succeeded.
  const reviewOutcome = parsedRecord.status === 'failed' || parsedRecord.reviewOutcome === 'failed' ? 'failed'
    : parsedRecord.status === 'partial' || parsedRecord.reviewOutcome !== 'complete' || limits.findingsTruncated === true
      || (inventory.state !== undefined && inventory.state !== 'complete') ? 'partial' : 'complete';
  const { triage: _triage, publication: _publication, commentIds: _commentIds,
    materialization: _materialization, materializationFailures: _materializationFailures,
    perEngineOutcome: _perEngineOutcome, reviewedFingerprint: _reviewedFingerprint,
    engineId: _engineId, runRef: _runRef, updatedFindings: _updatedFindings, fileCount: _fileCount,
    quality: rawQuality, ...modelContent } = parsedRecord;
  const quality = ReviewQualityV1Schema.safeParse(rawQuality);
  const fileCount = admittedComparison?.inventory.files.length;
  const content = ReviewFindingsContentV2Schema.safeParse({
    ...modelContent,
    reviewOutcome,
    ...(quality.success ? { quality: quality.data } : {}),
    ...(fileCount !== undefined ? { fileCount } : {}),
    // The comparison binding is captured by the host, never by model JSON.
    comparisonId: params.intentInput && typeof params.intentInput === 'object'
      && 'comparisonId' in params.intentInput && typeof params.intentInput.comparisonId === 'string'
      ? params.intentInput.comparisonId : undefined,
    summary: summaryRaw,
    overviewMarkdown: typeof overviewMarkdownRaw === 'string' ? overviewMarkdownRaw : summaryRaw,
    findings,
    questions,
    assumptions,
    ...(proposedComments?.success ? { proposedComments: proposedComments.data } : {}),
    generatedAtMs: params.generatedAtMs,
  });

  return content.success ? content.data : null;
}

export function normalizeStrictJsonReviewOutput(params: Readonly<{
  runId: string;
  callId: string;
  sidechainId: string;
  backendId: string;
  backendTarget: BackendTargetRefV1;
  startedAtMs: number;
  finishedAtMs: number;
  rawText: string;
  intentInput?: unknown;
  retentionPolicy?: ExecutionRunRetentionPolicy;
}>): ExecutionRunProfileBoundedCompleteResult {
  const trimmed = params.rawText.trim();
  const parsedJson: unknown = parseTrailingJsonObject(trimmed);

  const parsedRecord =
    parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
      ? (parsedJson as Record<string, unknown>)
      : null;

  const answerMarkdownRaw = parsedRecord ? parsedRecord.answerMarkdown : null;
  const updatedFindingsRaw = parsedRecord ? parsedRecord.updatedFindings : null;
  const questionsRaw = parsedRecord ? parsedRecord.questions : null;
  const assumptionsRaw = parsedRecord ? parsedRecord.assumptions : null;
  const followUpIntent = ReviewFollowUpIntentInputSchema.safeParse(params.intentInput);
  if (followUpIntent.success) {
    const input = params.intentInput && typeof params.intentInput === 'object' && !Array.isArray(params.intentInput)
      ? params.intentInput as Record<string, unknown> : {};
    const admittedComparison = readAdmittedReviewComparison(input);
    const scopeAttribution = createReviewScopeAttribution(admittedComparison);
    if (typeof answerMarkdownRaw !== 'string' || answerMarkdownRaw.trim().length === 0) {
      const summary = 'Invalid review output (expected strict JSON).';
      return {
        status: 'failed',
        summary,
        toolResultOutput: {
          status: 'failed',
          summary,
          runId: params.runId,
          callId: params.callId,
          sidechainId: params.sidechainId,
          backendId: params.backendId,
          intent: 'review',
          startedAtMs: params.startedAtMs,
          finishedAtMs: params.finishedAtMs,
          error: { code: 'invalid_output' },
        },
      };
    }

    const updatedFindings = Array.isArray(updatedFindingsRaw)
      ? updatedFindingsRaw.flatMap((item) => {
        const parsedFinding = parseModelFinding(item);
        return parsedFinding.success ? [{ ...parsedFinding.data, scopeAttribution: scopeAttribution(parsedFinding.data) }] : [];
      })
      : undefined;
    const questions = Array.isArray(questionsRaw)
      ? questionsRaw.flatMap((item) => {
        const parsedQuestion = ReviewQuestionSchema.safeParse(stripOptionalModelNulls(item, ReviewQuestionSchema.shape));
        return parsedQuestion.success ? [parsedQuestion.data] : [];
      })
      : undefined;
    const assumptions = Array.isArray(assumptionsRaw)
      ? assumptionsRaw.flatMap((item) => {
        const parsedAssumption = ReviewAssumptionSchema.safeParse(stripOptionalModelNulls(item, ReviewAssumptionSchema.shape));
        return parsedAssumption.success ? [parsedAssumption.data] : [];
      })
      : undefined;

    const structuredMeta: ExecutionRunStructuredMeta = {
      kind: 'review_follow_up.v1',
      payload: {
        parentRunRef: followUpIntent.data.parentRunRef,
        threadId: followUpIntent.data.threadId,
        ...(followUpIntent.data.findingIds.length > 0 ? { findingIds: followUpIntent.data.findingIds } : {}),
        ...(followUpIntent.data.replyToQuestionId ? { replyToQuestionId: followUpIntent.data.replyToQuestionId } : {}),
        requestMarkdown: followUpIntent.data.messageMarkdown,
        answerMarkdown: answerMarkdownRaw,
        ...(updatedFindings ? { updatedFindings } : {}),
        ...(questions ? { questions } : {}),
        ...(assumptions ? { assumptions } : {}),
        generatedAtMs: params.finishedAtMs,
      },
    };
    const summary = firstMarkdownProse(answerMarkdownRaw) || 'Review follow-up completed.';
    return {
      status: 'succeeded',
      summary,
      toolResultOutput: {
        status: 'succeeded',
        summary,
        runId: params.runId,
        callId: params.callId,
        sidechainId: params.sidechainId,
        backendId: params.backendId,
        intent: 'review',
        startedAtMs: params.startedAtMs,
        finishedAtMs: params.finishedAtMs,
      },
      toolResultMeta: { happier: structuredMeta },
      structuredMeta,
    };
  }

  const content = normalizeParsedReviewContent({
    value: parsedJson, intentInput: params.intentInput, generatedAtMs: params.finishedAtMs,
  });
  if (!content) {
    const summary = 'Invalid review output (expected strict JSON).';
    return {
      status: 'failed',
      summary,
      toolResultOutput: {
        status: 'failed',
        summary,
        runId: params.runId,
        callId: params.callId,
        sidechainId: params.sidechainId,
        backendId: params.backendId,
        intent: 'review',
        startedAtMs: params.startedAtMs,
        finishedAtMs: params.finishedAtMs,
        error: { code: 'invalid_output' },
      },
    };
  }
  const findingsPayload = {
    ...content,
    runRef: {
      runId: params.runId,
      callId: params.callId,
      backendId: params.backendId,
      backendTarget: params.backendTarget,
      ...(params.retentionPolicy ? { retentionPolicy: params.retentionPolicy } : {}),
    },
  };
  const reviewOutcome = findingsPayload.reviewOutcome;

  const summary = findingsPayload.summary || 'Review completed.';
  const payloadFindings = findingsPayload.findings;
  const digestItems = payloadFindings.slice(0, 20).map((f) => ({
    id: f.id,
    title: f.title,
    severity: f.severity,
    category: f.category,
    ...(f.filePath ? { filePath: f.filePath } : {}),
    ...(typeof f.startLine === 'number' ? { startLine: f.startLine } : {}),
    ...(typeof f.endLine === 'number' ? { endLine: f.endLine } : {}),
  }));

  const structuredMeta: ExecutionRunStructuredMeta = { kind: 'review_findings.v2', payload: findingsPayload };
  const failed = reviewOutcome === 'failed';
  const errorRecord = parsedRecord?.error
    && typeof parsedRecord.error === 'object'
    && !Array.isArray(parsedRecord.error)
      ? parsedRecord.error as Record<string, unknown>
      : null;
  const failureCode = typeof errorRecord?.code === 'string' && errorRecord.code.trim()
    ? errorRecord.code
    : 'review_failed';
  const output = {
    status: failed ? 'failed' : 'succeeded',
    reviewOutcome,
    summary,
    runId: params.runId,
    callId: params.callId,
    sidechainId: params.sidechainId,
    backendId: params.backendId,
    intent: 'review',
    startedAtMs: params.startedAtMs,
    finishedAtMs: params.finishedAtMs,
    findingsDigest: { total: payloadFindings.length, items: digestItems },
    ...(failed ? { error: { code: failureCode } } : {}),
  };

  return {
    status: failed ? 'failed' : 'succeeded',
    summary,
    toolResultOutput: output,
    toolResultMeta: { happier: structuredMeta },
    structuredMeta,
  };
}
