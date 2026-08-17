import { z } from 'zod';

import { VoiceAssistantActionSchema } from '../../voice/actions.js';
import { VoiceAgentOutputEventV1Schema } from '../../voice/outputEvents.js';
import { PendingLocalIdSchema } from '../../sessions/pending/pendingLocalId.js';
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

// Streaming turn IO (V1: used for intent='voice_agent').
export const ExecutionRunTurnStreamStartRequestSchema = z.object({
  runId: z.string().min(1),
  message: z.string().min(1),
  displayMessage: z.string().min(1).optional(),
  resume: z.boolean().optional(),
}).passthrough();
export type ExecutionRunTurnStreamStartRequest = z.infer<typeof ExecutionRunTurnStreamStartRequestSchema>;

export const ExecutionRunUserTranscriptDirectiveSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('persist'),
    localId: PendingLocalIdSchema,
  }),
  z.object({
    mode: z.literal('suppress'),
  }),
]);
export type ExecutionRunUserTranscriptDirective = z.infer<typeof ExecutionRunUserTranscriptDirectiveSchema>;

export const ExecutionRunTurnStreamStartV2RequestSchema = ExecutionRunTurnStreamStartRequestSchema.extend({
  userTranscript: ExecutionRunUserTranscriptDirectiveSchema,
});
export type ExecutionRunTurnStreamStartV2Request = z.infer<typeof ExecutionRunTurnStreamStartV2RequestSchema>;

export const ExecutionRunTurnStreamStartResponseSchema = z.object({
  streamId: z.string().min(1),
}).passthrough();
export type ExecutionRunTurnStreamStartResponse = z.infer<typeof ExecutionRunTurnStreamStartResponseSchema>;

const ExecutionRunUserTranscriptCommitPredecessorRequestSchema = z.object({
  runId: z.string().min(1),
  message: z.string().min(1),
  displayMessage: z.string().min(1).optional(),
  localId: PendingLocalIdSchema,
  text: z.never().optional(),
  displayText: z.never().optional(),
}).passthrough();

const ExecutionRunUserTranscriptCommitCurrentDevAliasRequestSchema = z.object({
  runId: z.string().min(1),
  text: z.string().min(1),
  displayText: z.string().min(1).optional(),
  localId: PendingLocalIdSchema,
  message: z.never().optional(),
  displayMessage: z.never().optional(),
}).passthrough();

/**
 * Canonical writes retain the prospective predecessor vocabulary observed at
 * ../remote-dev@0649e4de85aacf08476063fef1990f418ce8e80b in
 * packages/protocol/src/executionRuns.ts. The text/displayText branch is a
 * bounded read alias for already-running undeployed dev clients from
 * dev@877ee97a0df346a1daaa541632dc42643d533120. Remove that alias once those
 * clients have been drained/refreshed and before the first supported release
 * of this method; it is not a lasting wire contract.
 */
export const ExecutionRunUserTranscriptCommitRequestSchema = z.union([
  ExecutionRunUserTranscriptCommitPredecessorRequestSchema,
  ExecutionRunUserTranscriptCommitCurrentDevAliasRequestSchema,
]);
export type ExecutionRunUserTranscriptCommitRequest = z.infer<typeof ExecutionRunUserTranscriptCommitRequestSchema>;

export const ExecutionRunUserTranscriptCommitResponseSchema = z.object({
  ok: z.literal(true),
}).passthrough();
export type ExecutionRunUserTranscriptCommitResponse = z.infer<typeof ExecutionRunUserTranscriptCommitResponseSchema>;

export const ExecutionRunTurnStreamReadRequestSchema = z.object({
  runId: z.string().min(1),
  streamId: z.string().min(1),
  cursor: z.number().int().min(0),
  maxEvents: z.number().int().min(1).max(256).optional(),
}).passthrough();
export type ExecutionRunTurnStreamReadRequest = z.infer<typeof ExecutionRunTurnStreamReadRequestSchema>;

export const ExecutionRunTurnStreamEventDeltaSchema = z.object({
  t: z.literal('delta'),
  textDelta: z.string(),
}).passthrough();
export type ExecutionRunTurnStreamEventDelta = z.infer<typeof ExecutionRunTurnStreamEventDeltaSchema>;

export const ExecutionRunTurnStreamEventDoneSchema = z.object({
  t: z.literal('done'),
  assistantText: z.string(),
  actions: z.array(VoiceAssistantActionSchema).optional(),
}).passthrough();
export type ExecutionRunTurnStreamEventDone = z.infer<typeof ExecutionRunTurnStreamEventDoneSchema>;

export const ExecutionRunTurnStreamEventErrorSchema = z.object({
  t: z.literal('error'),
  error: z.string(),
  errorCode: z.string().optional(),
}).passthrough();
export type ExecutionRunTurnStreamEventError = z.infer<typeof ExecutionRunTurnStreamEventErrorSchema>;

export const ExecutionRunTurnStreamEventCancelledSchema = z.object({
  t: z.literal('cancelled'),
}).passthrough();
export type ExecutionRunTurnStreamEventCancelled = z.infer<typeof ExecutionRunTurnStreamEventCancelledSchema>;

export const ExecutionRunTurnStreamEventVoiceOutputSchema = z.object({
  t: z.literal('voice_output'),
  output: VoiceAgentOutputEventV1Schema,
}).strict();
export type ExecutionRunTurnStreamEventVoiceOutput = z.infer<typeof ExecutionRunTurnStreamEventVoiceOutputSchema>;

export const ExecutionRunTurnStreamEventSchema = z.discriminatedUnion('t', [
  ExecutionRunTurnStreamEventDeltaSchema,
  ExecutionRunTurnStreamEventDoneSchema,
  ExecutionRunTurnStreamEventErrorSchema,
  ExecutionRunTurnStreamEventCancelledSchema,
  ExecutionRunTurnStreamEventVoiceOutputSchema,
]);
export type ExecutionRunTurnStreamEvent = z.infer<typeof ExecutionRunTurnStreamEventSchema>;

export const ExecutionRunTurnStreamReadResponseSchema = z.object({
  streamId: z.string().min(1),
  events: z.array(ExecutionRunTurnStreamEventSchema),
  nextCursor: z.number().int().min(0),
  done: z.boolean(),
}).passthrough();
export type ExecutionRunTurnStreamReadResponse = z.infer<typeof ExecutionRunTurnStreamReadResponseSchema>;

export const ExecutionRunTurnStreamCancelRequestSchema = z.object({
  runId: z.string().min(1),
  streamId: z.string().min(1),
}).passthrough();
export type ExecutionRunTurnStreamCancelRequest = z.infer<typeof ExecutionRunTurnStreamCancelRequestSchema>;

export const ExecutionRunTurnStreamCancelResponseSchema = z.object({
  ok: z.literal(true),
}).passthrough();
export type ExecutionRunTurnStreamCancelResponse = z.infer<typeof ExecutionRunTurnStreamCancelResponseSchema>;
