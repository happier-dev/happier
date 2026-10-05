import { ReviewFindingsV1Schema, ReviewFindingsV2Schema } from '@happier-dev/protocol';
import type { ExecutionRunStructuredMeta } from '@/agent/executionRuns/profiles/ExecutionRunIntentProfile';
import type { ReviewRunCommentService, ReviewRunMaterialization } from '@/agent/executionRuns/profiles/review/reviewComments';
import { buildReviewFindingsV2Payload } from '@/agent/reviews/normalize/buildReviewFindingsV2Payload';
import type { ExecutionRunState } from './executionRunTypes';

type ReviewToolResult = Readonly<{ output: unknown; isError?: boolean; meta?: Record<string, unknown> }>;
type MaterializedReviewFindings = Readonly<{
  toolResult: ReviewToolResult;
  structuredMeta?: ExecutionRunStructuredMeta;
  materialization?: ReviewRunMaterialization;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Both bounded completion and retained turns persist through the incumbent ReviewComment owner. */
export async function materializeReviewFindings(args: Readonly<{
  run: ExecutionRunState;
  toolResult: ReviewToolResult;
  structuredMeta?: ExecutionRunStructuredMeta;
  expectFindings: boolean;
  reviewComments?: ReviewRunCommentService;
  workflowRunId?: string;
}>): Promise<MaterializedReviewFindings> {
  if (args.run.intent !== 'review' || args.structuredMeta?.kind === 'scm_diff_summary.v1'
    || args.structuredMeta?.kind === 'review_follow_up.v1') {
    return { toolResult: args.toolResult, structuredMeta: args.structuredMeta };
  }
  const input = record(args.run.intentInput);
  const reviewedFingerprint = typeof input?.reviewedFingerprint === 'string' ? input.reviewedFingerprint : null;
  const output = record(args.toolResult.output) ?? { result: args.toolResult.output };
  const toolResult = { ...args.toolResult, output: { ...output, reviewedFingerprint } };
  if (!args.expectFindings) return { toolResult, structuredMeta: args.structuredMeta };
  const parsed = args.structuredMeta?.kind === 'review_findings.v2'
    ? ReviewFindingsV2Schema.safeParse(args.structuredMeta.payload)
    : ReviewFindingsV1Schema.safeParse(args.structuredMeta?.payload);
  if (!parsed.success || parsed.data.runRef.runId !== args.run.runId
    || parsed.data.runRef.callId !== args.run.callId || parsed.data.runRef.backendId !== args.run.backendId) {
    const meta = { ...toolResult.meta };
    delete meta.happier;
    return {
      materialization: { engineId: args.run.backendId, status: 'failed', commentIds: [], comments: [],
        failures: [{ findingId: args.run.runId, errorCode: 'review_findings_invalid' }] },
      toolResult: { ...toolResult, meta, isError: true, output: {
        result: args.toolResult.output, engineId: args.run.backendId, reviewedFingerprint, commentIds: [],
        materialization: { kind: 'failed', errorCode: 'review_findings_invalid' },
        perEngineOutcome: [{ key: args.run.backendId, runId: args.run.runId, outcome: 'failed' }],
      } },
    };
  }
  const materialization: ReviewRunMaterialization = args.reviewComments
    ? await args.reviewComments.materialize({ run: args.run, findings: parsed.data.findings, reviewedFingerprint,
      ...(args.workflowRunId ? { workflowRunId: args.workflowRunId } : {}) })
    : { engineId: args.run.backendId, status: parsed.data.findings.length ? 'failed' : 'materialized',
      commentIds: [], comments: [], failures: parsed.data.findings.map((finding) => ({ findingId: finding.id,
        errorCode: 'review_comment_materialization_unavailable' })) };
  const reviewOutcome = materialization.status === 'failed' || ('reviewOutcome' in parsed.data && parsed.data.reviewOutcome === 'failed')
      ? 'failed' as const : materialization.status === 'partial' || ('reviewOutcome' in parsed.data && parsed.data.reviewOutcome === 'partial')
        ? 'partial' as const : 'complete' as const;
  const projection = {
    engineId: args.run.backendId, reviewedFingerprint, commentIds: materialization.commentIds, reviewOutcome,
    materialization: materialization.status === 'materialized' ? { kind: 'complete' as const }
      : { kind: materialization.status, errorCode: 'review_comment_materialization_failed' },
    ...(materialization.failures.length ? { materializationFailures: materialization.failures } : {}),
    perEngineOutcome: [{ key: args.run.backendId, runId: args.run.runId,
      outcome: materialization.status === 'materialized' && reviewOutcome !== 'failed' ? 'completed' : 'failed' }],
  };
  const commentsByFinding = new Map(materialization.comments.map((entry) => [entry.findingId, entry.comment]));
  const findings = parsed.data.findings.map((finding) => {
    const comment = commentsByFinding.get(finding.id);
    return comment ? { ...finding, comment } : finding;
  });
  const payload = args.structuredMeta?.kind === 'review_findings.v2' ? parsed.data : buildReviewFindingsV2Payload({
    ...parsed.data.runRef, summary: parsed.data.summary, findings, triage: parsed.data.triage,
    limits: parsed.data.limits, generatedAtMs: parsed.data.generatedAtMs,
  });
  const structuredMeta = { kind: 'review_findings.v2', payload: { ...payload, ...projection, findings } };
  return {
    materialization, structuredMeta,
    toolResult: { ...toolResult, output: { ...output, ...projection, findings },
      meta: { ...toolResult.meta, happier: structuredMeta } },
  };
}
