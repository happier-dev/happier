import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import type { ReviewStartTerminalValueV1Schema } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import type { z } from '@happier-dev/protocol/zodRuntimePolicy';
import { ReviewPreparedRoundV1Schema, ReviewSessionInputV1Schema } from '@happier-dev/protocol/reviews/reviewRoundActionsV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { ReviewCommentWorkspaceV1 } from '@happier-dev/protocol/reviews/comments/v1';

import { normalizeParsedReviewContent } from '@/agent/reviews/normalize/normalizeStrictJsonReviewOutput';
import { parseTrailingJsonObject } from '@/agent/executionRuns/profiles/shared/parseTrailingJsonObject';
import { createReviewRunCommentService } from '@/agent/executionRuns/profiles/review/reviewComments';
import type { WorkflowStepExecutionResult, WorkflowStepExecutor } from './coordinator';

/** Actual Session input correspondence supplied by the Session execution owner. */
export type WorkflowSessionReviewInput = Readonly<{
  params: Parameters<WorkflowStepExecutor>[0];
  sessionId: string;
  localInputId: string;
  rawText: string;
}>;

/** Publish Session-authored content through the same signed ReviewComment owner as native reviews. */
export async function materializeWorkflowSessionReview(input: WorkflowSessionReviewInput & Readonly<{
  context: ActionExecutorContext;
  comments: NonNullable<ActionExecutorDeps['reviewCommentAction']>;
  workspace: ReviewCommentWorkspaceV1;
  agentId: string;
}>): Promise<WorkflowStepExecutionResult> {
  const selection = input.params.input.values.map(value => ReviewSessionInputV1Schema.safeParse(value))
    .find(result => result.success);
  const prepared = input.params.input.values.map(value => ReviewPreparedRoundV1Schema.safeParse(value))
    .find(result => result.success);
  if (!selection?.success || !prepared?.success) return { kind: 'failed', code: 'invalid_parameters' };
  const { reviewRound, comparisonId, comparison } = prepared.data;
  const intentInput = { reviewRound, ...(comparisonId ? { comparisonId } : {}), ...(comparison ? { comparison } : {}) };
  const content = normalizeParsedReviewContent({ value: parseTrailingJsonObject(input.rawText), intentInput, generatedAtMs: Date.now() });
  if (!content) return { kind: 'failed', code: 'invalid_output' };
  const service = createReviewRunCommentService({ cwd: input.workspace.path, scope: { workspace: input.workspace },
    execute: (actionId, value, options) => input.comments({ actionId, input: value,
      ...(options?.principal ? { reviewCommentPrincipal: options.principal } : {}),
      ...(input.context.signal ? { signal: input.context.signal } : {}) }),
  });
  const materialized = await service.materialize({ session: {
    sessionId: input.sessionId, localInputId: input.localInputId, workflowRunId: input.params.runId,
    stepId: input.params.step.id, invocationId: input.params.invocationRecordId ?? input.params.invocation.logicalInvocationRecordId,
    reviewerId: selection.data.reviewerId, agentId: input.agentId, cwd: input.workspace.path, intentInput,
  }, findings: content.findings, reviewedFingerprint: null, review: reviewRound,
    ...(comparison ? { comparison } : {}),
    ...(input.context.reviewCommentPrincipal?.workflowScope ? { workflowScope: input.context.reviewCommentPrincipal.workflowScope } : {}),
  });
  const materialization = materialized.status === 'materialized' ? { kind: 'complete' as const }
    : { kind: materialized.status, errorCode: materialized.failures[0]?.errorCode ?? 'review_comment_request_failed' };
  return { kind: 'completed', resultEncoding: 'typed', result: projectNativeJsonValueForTransport({
    reviewRound, reviewedFingerprint: null, commentIds: [...materialized.commentIds],
    perEngineOutcome: [{ key: selection.data.reviewerId, outcome: content.reviewOutcome === 'failed' ? 'failed' : 'completed',
      reviewOutcome: content.reviewOutcome, quality: content.quality, materialization }],
  } satisfies z.infer<typeof ReviewStartTerminalValueV1Schema>) };
}
