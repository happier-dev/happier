import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import type { ReviewCommentActionExecutor } from '@/agent/reviews/comments/executor';
import type { ReviewStartTerminalValueV1Schema } from '@happier-dev/protocol/actions/specs/executionRunCompletion';
import type { z } from '@happier-dev/protocol/zodRuntimePolicy';
import { ReviewPreparedRoundV1Schema, ReviewSessionInputV1Schema } from '@happier-dev/protocol/reviews/reviewRoundActionsV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import type { ReviewCommentWorkspaceV1 } from '@happier-dev/protocol/reviews/comments/v1';
import { createWorkflowActionRequestIdV1 } from '@happier-dev/protocol/workflows/workflowSessionScopeV1';

import { normalizeParsedReviewContent } from '@/agent/reviews/normalize/normalizeStrictJsonReviewOutput';
import { parseTrailingJsonObject } from '@/agent/executionRuns/profiles/shared/parseTrailingJsonObject';
import { createReviewRunCommentService } from '@/agent/executionRuns/profiles/review/reviewComments';
import type { WorkflowStepExecutionResult, WorkflowStepExecutor } from './coordinator';
import { readWorkflowSessionReplyFailureCode } from './stepExecution';

/** Actual Session input correspondence supplied by the Session execution owner. */
export type WorkflowSessionReviewInput = Readonly<{
  params: Parameters<WorkflowStepExecutor>[0];
  sessionId: string;
  localInputId: string;
  rawText: string;
}>;

/** A terminal reviewer failure is a Review receipt, so collect_outcomes retains its cause. */
export function projectWorkflowSessionReviewResult(
  params: Parameters<WorkflowStepExecutor>[0],
  result: WorkflowStepExecutionResult,
): WorkflowStepExecutionResult {
  if (result.kind !== 'failed') return result;
  const selection = params.input.values.map(value => ReviewSessionInputV1Schema.safeParse(value))
    .find(value => value.success);
  const prepared = params.input.values.map(value => ReviewPreparedRoundV1Schema.safeParse(value))
    .find(value => value.success);
  if (!selection?.success || !prepared?.success) return result;
  return { kind: 'completed', resultEncoding: 'typed',
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.replyOutcome ? { replyOutcome: result.replyOutcome } : {}),
    result: projectNativeJsonValueForTransport({ reviewRound: prepared.data.reviewRound,
      reviewedFingerprint: null, commentIds: [], perEngineOutcome: [{ key: selection.data.reviewerId,
        outcome: 'failed', errorCode: result.code,
        ...(result.runtimeIssueV1 ? { runtimeIssueV1: result.runtimeIssueV1 } : {}), finishedAt: Date.now() }],
    } satisfies z.infer<typeof ReviewStartTerminalValueV1Schema>),
  };
}

/** Publish Session-authored content through the same signed ReviewComment owner as native reviews. */
export async function materializeWorkflowSessionReview(input: WorkflowSessionReviewInput & Readonly<{
  context: ActionExecutorContext;
  comments: NonNullable<ActionExecutorDeps['reviewCommentAction']>;
  workspace: ReviewCommentWorkspaceV1;
  agentId: string;
  serverId: string;
}>): Promise<WorkflowStepExecutionResult> {
  const selection = input.params.input.values.map(value => ReviewSessionInputV1Schema.safeParse(value))
    .find(result => result.success);
  const prepared = input.params.input.values.map(value => ReviewPreparedRoundV1Schema.safeParse(value))
    .find(result => result.success);
  if (!selection?.success || !prepared?.success) return { kind: 'failed', code: 'invalid_parameters' };
  const { reviewRound, comparisonId, comparison, inlineThreshold } = prepared.data;
  const intentInput = { reviewRound, inlineThreshold, ...(comparisonId ? { comparisonId } : {}), ...(comparison ? { comparison } : {}) };
  const content = normalizeParsedReviewContent({ value: parseTrailingJsonObject(input.rawText), intentInput, generatedAtMs: Date.now() });
  if (!content) return { kind: 'failed', code: readWorkflowSessionReplyFailureCode(input.rawText, 'invalid_output') };
  const service = createReviewRunCommentService({ cwd: input.workspace.path, scope: { workspace: input.workspace },
    execute: Object.assign((...[actionId, value, options]: Parameters<ReviewCommentActionExecutor>) => input.comments({ actionId, input: value,
      ...(options?.principal ? { reviewCommentPrincipal: options.principal } : {}),
      ...(input.context.signal ? { signal: input.context.signal } : {}) }), {
      createBatch: input.comments.createBatch && ((...[items, options]: Parameters<NonNullable<ReviewCommentActionExecutor['createBatch']>>) => input.comments.createBatch!(items, {
        ...options, serverId: input.serverId, ...(input.context.signal ? { signal: input.context.signal } : {}),
      })),
    }),
  });
  const materialized = await service.materialize({ session: {
    sessionId: input.sessionId, localInputId: input.localInputId, workflowRunId: input.params.runId,
    stepId: input.params.step.id, invocationId: input.params.invocationRecordId ?? input.params.invocation.logicalInvocationRecordId,
    reviewerId: selection.data.reviewerId, agentId: input.agentId, cwd: input.workspace.path, intentInput,
  }, findings: content.findings, reviewedFingerprint: null, review: reviewRound,
    ...(comparison ? { comparison } : {}),
    workflowScope: {
      actionRequestId: createWorkflowActionRequestIdV1({ runId: input.params.runId,
        logicalInvocationId: input.params.invocation.logicalInvocationRecordId, attempt: input.params.invocation.attempt }),
      invocationId: input.params.invocationRecordId ?? input.params.invocation.logicalInvocationRecordId,
      sessions: [{ serverId: input.serverId, sessionId: input.sessionId }],
    },
  });
  const materialization = materialized.status === 'materialized' ? { kind: 'complete' as const }
    : { kind: materialized.status, errorCode: materialized.failures[0]?.errorCode ?? 'review_comment_request_failed' };
  return { kind: 'completed', resultEncoding: 'typed', result: projectNativeJsonValueForTransport({
    reviewRound, reviewedFingerprint: null, commentIds: [...materialized.commentIds],
    perEngineOutcome: [{ key: selection.data.reviewerId, outcome: content.reviewOutcome === 'failed' ? 'failed' : 'completed',
      reviewOutcome: content.reviewOutcome, quality: content.quality, materialization, finishedAt: Date.now() }],
  } satisfies z.infer<typeof ReviewStartTerminalValueV1Schema>) };
}
