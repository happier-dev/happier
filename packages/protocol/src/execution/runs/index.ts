import { z } from 'zod';

import {
  ExecutionRunClassSchema,
  type ExecutionRunClass,
  ExecutionRunDisplaySchema,
  type ExecutionRunDisplay,
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
  ExecutionRunTransportErrorCodeSchema,
  ExecutionRunStartRunCreationSchema,
  ExecutionRunStartFailureDetailsV1Schema,
  readExecutionRunStartRunCreation,
  withExecutionRunStartFailureDetails,
  ExecutionRunStatusSchema,
  ExecutionRunListRequestSchema,
  ExecutionRunErrorSchema,
  ExecutionRunTranscriptSchema,
  ExecutionRunPublicStateSchema,
  ExecutionRunListResponseSchema,
  ExecutionRunGetRequestSchema,
  ExecutionRunGetResponseSchema,
  ExecutionRunWaitResultSchema,
  ExecutionRunStartResponseSchema,
  ExecutionRunSendResponseSchema,
  ExecutionRunStopResponseSchema,
} from './responseSchemas.js';
export type {
  ExecutionRunTransportErrorCode,
  ExecutionRunStartRunCreation,
  ExecutionRunStartFailureDetailsV1,
  ExecutionRunStatus,
  ExecutionRunListRequest,
  ExecutionRunError,
  ExecutionRunTranscript,
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
  normalizeExecutionRunWaitPollIntervalMs,
  normalizeExecutionRunWaitTimeoutMs,
  waitForExecutionRunTerminal,
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
  ExecutionRunReplaySeedRequestSchema,
  ExecutionRunVoiceAgentIntentInputV1Schema,
  EXECUTION_RUN_TASK_INSTRUCTIONS_MAX_CHARS,
  ExecutionRunTaskIntentInputV1Schema,
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
  ExecutionRunReplaySeedRequest,
  ExecutionRunVoiceAgentIntentInputV1,
  ExecutionRunTaskIntentInputV1,
  ExecutionRunScmCommitMessageScopeV1,
  ExecutionRunScmCommitMessageInputV1,
  ExecutionRunScmCommitMessageResultV1,
  ExecutionRunScmDiffSummaryInputV1,
  ExecutionRunScmDiffSummaryResultV1,
  ExecutionRunStartRequest,
  ExecutionRunDetachedStartRequestV1,
};

export const ExecutionRunSendRequestSchema = z.object({
  runId: z.string().min(1),
  message: z.string().min(1),
  resume: z.boolean().optional(),
  delivery: z.enum(['prompt', 'steer_if_supported', 'interrupt']).optional(),
}).passthrough();
export type ExecutionRunSendRequest = z.infer<typeof ExecutionRunSendRequestSchema>;

export const ExecutionRunStopRequestSchema = z.object({ runId: z.string().min(1) }).passthrough();
export type ExecutionRunStopRequest = z.infer<typeof ExecutionRunStopRequestSchema>;

export const ExecutionRunEnsureRequestSchema = z.object({
  runId: z.string().min(1),
  resume: z.boolean().optional(),
}).passthrough();
export type ExecutionRunEnsureRequest = z.infer<typeof ExecutionRunEnsureRequestSchema>;

export const ExecutionRunEnsureResponseSchema = z.union([
  z.object({ ok: z.literal(true) }).passthrough(),
  z.object({ ok: z.literal(false), error: z.string().min(1), errorCode: z.string().min(1).optional() }).passthrough(),
]);
export type ExecutionRunEnsureResponse = z.infer<typeof ExecutionRunEnsureResponseSchema>;

export const ExecutionRunEnsureOrStartRequestSchema = z.object({
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
});
export type ExecutionRunEnsureOrStartRequest = z.infer<typeof ExecutionRunEnsureOrStartRequestSchema>;

export const ExecutionRunEnsureOrStartResponseSchema = z.union([
  z.object({ ok: z.literal(true), runId: z.string().min(1), created: z.boolean() }).passthrough(),
  z.object({ ok: z.literal(false), error: z.string().min(1), errorCode: z.string().min(1).optional() }).passthrough(),
]);
export type ExecutionRunEnsureOrStartResponse = z.infer<typeof ExecutionRunEnsureOrStartResponseSchema>;

export const ExecutionRunActionRequestSchema = z.object({
  runId: z.string().min(1),
  actionId: z.string().min(1),
  input: z.unknown().optional(),
}).passthrough();
export type ExecutionRunActionRequest = z.infer<typeof ExecutionRunActionRequestSchema>;

export const ExecutionRunActionResponseSchema = z.object({
  ok: z.boolean(),
  updatedToolResult: z.unknown().optional(),
}).passthrough();
export type ExecutionRunActionResponse = z.infer<typeof ExecutionRunActionResponseSchema>;

export * from './streaming.js';
