import {
  type BackendTargetRefV1,
  type ExecutionRunRetentionPolicy,
  ReviewAssumptionSchema,
  ReviewFindingSchema,
  ReviewQuestionSchema,
  ReviewCommentProposalsV1Schema,
  ReviewFindingsV2Schema,
  type ReviewFinding,
} from '@happier-dev/protocol';

import type {
  ExecutionRunProfileBoundedCompleteResult,
  ExecutionRunStructuredMeta,
} from '../../executionRuns/profiles/ExecutionRunIntentProfile';
import { ReviewFollowUpIntentInputSchema } from '../followUp/reviewFollowUpIntentInput';
import { parseTrailingJsonObject } from '../../executionRuns/profiles/shared/parseTrailingJsonObject';

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
  const parsedJson: any = parseTrailingJsonObject(trimmed);

  const parsedRecord =
    parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)
      ? (parsedJson as Record<string, unknown>)
      : null;

  const summaryRaw = parsedRecord ? parsedRecord.summary : null;
  const answerMarkdownRaw = parsedRecord ? parsedRecord.answerMarkdown : null;
  const overviewMarkdownRaw = parsedRecord ? parsedRecord.overviewMarkdown : null;
  const findingsRaw = parsedRecord ? parsedRecord.findings : null;
  const updatedFindingsRaw = parsedRecord ? parsedRecord.updatedFindings : null;
  const questionsRaw = parsedRecord ? parsedRecord.questions : null;
  const assumptionsRaw = parsedRecord ? parsedRecord.assumptions : null;
  const proposedCommentsRaw = parsedRecord ? parsedRecord.proposedComments : undefined;

  const followUpIntent = ReviewFollowUpIntentInputSchema.safeParse(params.intentInput);
  if (followUpIntent.success) {
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
        const parsedFinding = ReviewFindingSchema.safeParse(item);
        return parsedFinding.success ? [parsedFinding.data] : [];
      })
      : undefined;
    const questions = Array.isArray(questionsRaw)
      ? questionsRaw.flatMap((item) => {
        const parsedQuestion = ReviewQuestionSchema.safeParse(item);
        return parsedQuestion.success ? [parsedQuestion.data] : [];
      })
      : undefined;
    const assumptions = Array.isArray(assumptionsRaw)
      ? assumptionsRaw.flatMap((item) => {
        const parsedAssumption = ReviewAssumptionSchema.safeParse(item);
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
    const summary = answerMarkdownRaw.split('\n')[0]?.trim() || 'Review follow-up completed.';
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
      toolResultMeta: { happier: structuredMeta } as any,
      structuredMeta,
    };
  }

  if (!parsedRecord || typeof summaryRaw !== 'string' || summaryRaw.trim().length === 0 || !Array.isArray(findingsRaw)) {
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

  const findings: ReviewFinding[] = [];
  for (const item of findingsRaw) {
    const parsedFinding = ReviewFindingSchema.safeParse(item);
    if (!parsedFinding.success) {
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
    findings.push(parsedFinding.data);
  }

  const questions = Array.isArray(questionsRaw)
    ? questionsRaw.flatMap((item) => {
      const parsedQuestion = ReviewQuestionSchema.safeParse(item);
      return parsedQuestion.success ? [parsedQuestion.data] : [];
    })
    : [];
  const assumptions = Array.isArray(assumptionsRaw)
    ? assumptionsRaw.flatMap((item) => {
      const parsedAssumption = ReviewAssumptionSchema.safeParse(item);
      return parsedAssumption.success ? [parsedAssumption.data] : [];
    })
    : [];
  const proposedComments = typeof proposedCommentsRaw === 'undefined'
    ? undefined
    : ReviewCommentProposalsV1Schema.safeParse(proposedCommentsRaw);
  if (proposedComments && !proposedComments.success) {
    const summary = 'Invalid review output (expected strict JSON).';
    return {
      status: 'failed',
      summary,
      toolResultOutput: {
        status: 'failed', summary, runId: params.runId, callId: params.callId,
        sidechainId: params.sidechainId, backendId: params.backendId, intent: 'review',
        startedAtMs: params.startedAtMs, finishedAtMs: params.finishedAtMs,
        error: { code: 'invalid_output' },
      },
    };
  }

  const findingsPayload = ReviewFindingsV2Schema.parse({
    ...parsedRecord,
    runRef: {
      runId: params.runId,
      callId: params.callId,
      backendId: params.backendId,
      backendTarget: params.backendTarget,
      ...(params.retentionPolicy ? { retentionPolicy: params.retentionPolicy } : {}),
    },
    summary: summaryRaw,
    overviewMarkdown: typeof overviewMarkdownRaw === 'string' ? overviewMarkdownRaw : summaryRaw,
    findings,
    questions,
    assumptions,
    ...(proposedComments?.success ? { proposedComments: proposedComments.data } : {}),
    generatedAtMs: params.finishedAtMs,
  });

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
  const failed = parsedRecord.status === 'failed';
  const errorRecord = parsedRecord.error
    && typeof parsedRecord.error === 'object'
    && !Array.isArray(parsedRecord.error)
      ? parsedRecord.error as Record<string, unknown>
      : null;
  const failureCode = typeof errorRecord?.code === 'string' && errorRecord.code.trim()
    ? errorRecord.code
    : 'review_failed';
  const output = {
    status: failed ? 'failed' : 'succeeded',
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
    toolResultMeta: { happier: structuredMeta } as any,
    structuredMeta,
  };
}
