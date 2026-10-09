import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { ExecutionRunResultContractV1Schema } from './resultContractV1.js';
import { HappierStructuredInputV1Schema } from '../../runtime/input/structuredInputV1.js';
export {
  ExecutionRunRequestedConfigurationSchema,
  projectExecutionRunRequestedConfiguration,
  type ExecutionRunRequestedConfiguration,
} from './requestedConfiguration.js';

import {
  ExecutionRunClassSchema,
  type ExecutionRunClass,
  ExecutionRunDisplaySchema,
  type ExecutionRunDisplay,
  ExecutionRunLaunchOriginSchema,
  type ExecutionRunLaunchOrigin,
  ExecutionRunDraftCorrelationIdSchema,
  type ExecutionRunDraftCorrelationId,
  ExecutionRunIntentSchema,
  type ExecutionRunIntent,
  ExecutionRunKindSchema,
  type ExecutionRunKind,
  ExecutionRunIoModeSchema,
  type ExecutionRunIoMode,
  ExecutionRunReplaySeedRequestSchema,
  type ExecutionRunReplaySeedRequest,
  ExecutionRunVoiceAgentIntentInputV1Schema,
  type ExecutionRunVoiceAgentIntentInputV1,
  EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS,
  ExecutionRunTaskIntentInputV1Schema,
  ExecutionRunAgentIntentInputV1Schema,
  type ExecutionRunAgentIntentInputV1,
  ExecutionRunInitialInputV1Schema,
  type ExecutionRunInitialInputV1,
  type ExecutionRunTaskIntentInputV1,
  ExecutionRunResumeHandleSchema,
  type ExecutionRunResumeHandle,
  ExecutionRunResumeHandleProviderSessionV1Schema,
  type ExecutionRunResumeHandleProviderSessionV1,
  ExecutionRunResumeHandleVoiceAgentSessionsV1Schema,
  type ExecutionRunResumeHandleVoiceAgentSessionsV1,
  ExecutionRunRetentionPolicySchema,
  type ExecutionRunRetentionPolicy,
  ExecutionRunScmCommitMessageInputV1Schema,
  type ExecutionRunScmCommitMessageInputV1,
  ExecutionRunScmCommitMessageResultV1Schema,
  type ExecutionRunScmCommitMessageResultV1,
  ExecutionRunScmCommitMessageScopeV1Schema,
  type ExecutionRunScmCommitMessageScopeV1,
  ExecutionRunScmDiffSummaryInputV1Schema,
  type ExecutionRunScmDiffSummaryInputV1,
  ExecutionRunScmDiffSummaryResultV1Schema,
  type ExecutionRunScmDiffSummaryResultV1,
  ExecutionRunStartRequestSchema,
  type ExecutionRunStartRequest,
  ExecutionRunDetachedStartRequestV1Schema,
  type ExecutionRunDetachedStartRequestV1,
  EXECUTION_RUN_DETACHED_START_PROMPT_FIELDS_V1,
  normalizeLegacyExecutionRunBackendTargetInput,
} from './startRequest.js';
export {
  ExecutionRunTeamCredentialSessionBindingConsentV1Schema,
  type ExecutionRunTeamCredentialSessionBindingConsentV1,
} from './startRequest.js';
export {
  ExecutionRunTransportErrorCodeSchema,
  ExecutionRunStartRunCreationSchema,
  ExecutionRunStartFailureDetailsV1Schema,
  readExecutionRunStartRunCreation,
  withExecutionRunStartFailureDetails,
  ExecutionRunStatusSchema,
  ExecutionRunListRequestSchema,
  ExecutionRunErrorSchema,
  ExecutionRunTranscriptSchema,
  ExecutionRunInputTurnV1Schema,
  ExecutionRunTurnResultV1Schema,
  ExecutionRunPublicStateSchema,
  isExecutionRunActive,
  ExecutionRunListResponseSchema,
  ExecutionRunGetRequestSchema,
  ExecutionRunGetResponseSchema,
  ExecutionRunWaitResultSchema,
  ExecutionRunStartResponseSchema,
  ExecutionRunSendResponseSchema,
  ExecutionRunStopResponseSchema,
} from './responseSchemas.js';
export {
  ExecutionRunInteractionV1Schema,
} from './executionRunInteractionV1.js';
export {
  NO_EXECUTION_RUN_INTERACTION,
  resolveExecutionRunInteractionAffordances,
  type ExecutionRunInteractionAffordances,
} from './interactionAffordances.js';
export type {
  ExecutionRunInteractionV1,
} from './executionRunInteractionV1.js';
export {
  ExecutionRunLifecycleV1Schema,
  type ExecutionRunLifecycleV1,
} from './executionRunLifecycleV1.js';
export {
  ExecutionRunCompletionV1Schema,
  type ExecutionRunCompletionV1,
} from './completionInputV1.js';
export { resolveExecutionRunNotifyParentDefaultV1 } from './executionRunNotifyParentDefaultV1.js';
export type {
  ExecutionRunTransportErrorCode,
  ExecutionRunStartRunCreation,
  ExecutionRunStartFailureDetailsV1,
  ExecutionRunStatus,
  ExecutionRunListRequest,
  ExecutionRunError,
  ExecutionRunTranscript,
  ExecutionRunInputTurnV1,
  ExecutionRunTurnResultV1,
  ExecutionRunPublicState,
  ExecutionRunListResponse,
  ExecutionRunGetRequest,
  ExecutionRunGetResponse,
  ExecutionRunWaitResult,
  ExecutionRunStartResponse,
  ExecutionRunSendResponse,
  ExecutionRunStopResponse,
} from './responseSchemas.js';
export {
  ExecutionRunTerminalStatusSchema,
  isExecutionRunTerminalStatus,
  normalizeExecutionRunWaitTimeoutMs,
  waitForExecutionRunTerminal,
  ExecutionRunWaitConditionSchema,
  executionRunNeedsAttention,
  type ExecutionRunWaitCondition,
  type ExecutionRunTerminalStatus,
  type ExecutionRunWaitFailure,
  type ExecutionRunWaitReadResult,
  type ExecutionRunWaitLoopResult,
} from './waitForTerminal.js';

/**
 * Public contract for execution runs (sub-agents / reviews / planning / delegation / voice agent).
 *
 * Notes:
 * - This schema is used by session-scoped RPC + MCP and must remain stable and bounded.
 * - Rich/large UI payloads (e.g. full review findings) are carried via transcript message `meta.happier`.
 */

export {
  ExecutionRunIntentSchema,
  ExecutionRunKindSchema,
  ExecutionRunRetentionPolicySchema,
  ExecutionRunClassSchema,
  ExecutionRunIoModeSchema,
  normalizeLegacyExecutionRunBackendTargetInput,
  ExecutionRunResumeHandleProviderSessionV1Schema,
  ExecutionRunResumeHandleVoiceAgentSessionsV1Schema,
  ExecutionRunResumeHandleSchema,
  ExecutionRunDisplaySchema,
  ExecutionRunLaunchOriginSchema,
  ExecutionRunDraftCorrelationIdSchema,
  ExecutionRunReplaySeedRequestSchema,
  ExecutionRunVoiceAgentIntentInputV1Schema,
  EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS,
  ExecutionRunTaskIntentInputV1Schema,
  ExecutionRunAgentIntentInputV1Schema,
  ExecutionRunInitialInputV1Schema,
  ExecutionRunScmCommitMessageScopeV1Schema,
  ExecutionRunScmCommitMessageInputV1Schema,
  ExecutionRunScmCommitMessageResultV1Schema,
  ExecutionRunScmDiffSummaryInputV1Schema,
  ExecutionRunScmDiffSummaryResultV1Schema,
  ExecutionRunStartRequestSchema,
  ExecutionRunDetachedStartRequestV1Schema,
  EXECUTION_RUN_DETACHED_START_PROMPT_FIELDS_V1,
};
export type {
  ExecutionRunIntent,
  ExecutionRunKind,
  ExecutionRunRetentionPolicy,
  ExecutionRunClass,
  ExecutionRunIoMode,
  ExecutionRunResumeHandleProviderSessionV1,
  ExecutionRunResumeHandleVoiceAgentSessionsV1,
  ExecutionRunResumeHandle,
  ExecutionRunDisplay,
  ExecutionRunLaunchOrigin,
  ExecutionRunDraftCorrelationId,
  ExecutionRunReplaySeedRequest,
  ExecutionRunVoiceAgentIntentInputV1,
  ExecutionRunTaskIntentInputV1,
  ExecutionRunAgentIntentInputV1,
  ExecutionRunInitialInputV1,
  ExecutionRunScmCommitMessageScopeV1,
  ExecutionRunScmCommitMessageInputV1,
  ExecutionRunScmCommitMessageResultV1,
  ExecutionRunScmDiffSummaryInputV1,
  ExecutionRunScmDiffSummaryResultV1,
  ExecutionRunStartRequest,
  ExecutionRunDetachedStartRequestV1,
};

export {
  ExecutionRunResultContractV1Schema,
  type ExecutionRunResultContractV1,
} from './resultContractV1.js';

export {
  normalizeExecutionRunProfileResultContract,
  buildExecutionRunResultContractPrompt,
  decodeExecutionRunProfileResult,
  decodeExecutionRunResultObservation,
  validateExecutionRunProfileResult,
  type ExecutionRunProfileResultContract,
  type ExecutionRunResultDecodeResult,
  type ExecutionRunResultObservation,
} from './resultContract.js';

export const ExecutionRunSendRequestSchema = lazyZodSchema(() => z.object({
  runId: z.string().min(1),
  message: z.string().min(1),
  localInputId: z.string().trim().min(1).optional(),
  resultContract: ExecutionRunResultContractV1Schema.optional(),
  /** Canonical host-owned structured input for this native turn. */
  structuredInput: HappierStructuredInputV1Schema.optional(),
  resume: z.boolean().optional(),
  delivery: z.enum(['prompt', 'steer_if_supported', 'interrupt']).optional(),
}).passthrough().superRefine((value, ctx) => {
  if (value.resultContract && !value.localInputId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['localInputId'],
      message: 'resultContract requires exact localInputId correspondence',
    });
  }
}));
export type ExecutionRunSendRequest = z.infer<typeof ExecutionRunSendRequestSchema>;

export const ExecutionRunStopRequestSchema = lazyZodSchema(() => z.object({ runId: z.string().min(1) }).passthrough());
export type ExecutionRunStopRequest = z.infer<typeof ExecutionRunStopRequestSchema>;

export {
  ExecutionRunCancelTurnRequestSchema,
  ExecutionRunCancelTurnResponseSchema,
  type ExecutionRunCancelTurnRequest,
  type ExecutionRunCancelTurnResponse,
} from './cancelTurn.js';

export const ExecutionRunEnsureRequestSchema = lazyZodSchema(() => z.object({
  runId: z.string().min(1),
  resume: z.boolean().optional(),
}).passthrough());
export type ExecutionRunEnsureRequest = z.infer<typeof ExecutionRunEnsureRequestSchema>;

export const ExecutionRunEnsureResponseSchema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z.object({ ok: z.literal(false), error: z.string().min(1), errorCode: z.string().min(1).optional() }).passthrough(),
]));
export type ExecutionRunEnsureResponse = z.infer<typeof ExecutionRunEnsureResponseSchema>;

export const ExecutionRunEnsureOrStartRequestSchema = lazyZodSchema(() => z.object({
  runId: z.string().min(1).nullable().optional(),
  start: ExecutionRunStartRequestSchema.optional(),
  resume: z.boolean().optional(),
}).passthrough().superRefine((value, ctx) => {
  const runId = typeof value.runId === 'string' ? value.runId.trim() : '';
  if (!runId) {
    if (!value.start) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'start is required when runId is missing' });
    }
  }
}));
export type ExecutionRunEnsureOrStartRequest = z.infer<typeof ExecutionRunEnsureOrStartRequestSchema>;

export const ExecutionRunEnsureOrStartResponseSchema = lazyZodSchema(() => z.union([
  z.object({ ok: z.literal(true), runId: z.string().min(1), created: z.boolean() }).passthrough(),
  z.object({ ok: z.literal(false), error: z.string().min(1), errorCode: z.string().min(1).optional() }).passthrough(),
]));
export type ExecutionRunEnsureOrStartResponse = z.infer<typeof ExecutionRunEnsureOrStartResponseSchema>;

export const ExecutionRunActionRequestSchema = lazyZodSchema(() => z.object({
  runId: z.string().min(1),
  actionId: z.string().min(1),
  input: z.unknown().optional(),
}).passthrough());
export type ExecutionRunActionRequest = z.infer<typeof ExecutionRunActionRequestSchema>;

/** Runtime admission reasons for asking a retained reviewer a follow-up question. */
export const ReviewFollowUpFailureCodeSchema = lazyZodSchema(() => z.enum([
  'review_follow_up_not_resumable',
  'review_follow_up_ended',
  'review_follow_up_resume_unavailable',
  'execution_run_busy',
  // Older runtimes used this generic refusal for non-resumable reviews.
  'execution_run_action_not_supported',
]));
export type ReviewFollowUpFailureCode = z.infer<typeof ReviewFollowUpFailureCodeSchema>;

export const ExecutionRunActionResponseSchema = lazyZodSchema(() => z.object({
  ok: z.boolean(),
  updatedToolResult: z.unknown().optional(),
}).passthrough());
export type ExecutionRunActionResponse = z.infer<typeof ExecutionRunActionResponseSchema>;

export * from './streaming.js';
