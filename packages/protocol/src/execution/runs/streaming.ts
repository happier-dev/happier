import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { VoiceAssistantActionSchema } from '../../voice/actions.js';
import { VoiceAgentOutputEventV1Schema } from '../../voice/outputEvents.js';
import { PendingLocalIdSchema } from '../../sessions/pending/pendingLocalId.js';
import { SessionUsageLimitRecoveryDisplayV1Schema } from '../../sessions/state/valueSchemas/usageLimitRecovery.js';
import { SessionRuntimeIssueV1Schema } from '../../sessions/control/runtimeIssueV1.js';
import { ExecutionRunPreparedInstructionsForSchema } from './runPrimitives.js';
export { ExecutionRunPreparedInstructionsForSchema } from './runPrimitives.js';

export {
  ExecutionRunTurnStreamReadRequestSchema,
  type ExecutionRunTurnStreamReadRequest,
} from './runPrimitives.js';

// Streaming turn IO (V1: used for intent='voice_agent').
export const ExecutionRunTurnStreamStartRequestSchema = lazyZodSchema(() => z.looseObject({
  runId: z.string().check(z.minLength(1)),
  message: z.string().check(z.minLength(1)),
  displayMessage: z.optional(z.string().check(z.minLength(1))),
  resume: z.optional(z.boolean()),
  /** Voice latency preference; provider request-size limits remain separate. */
  speechSegmentTargetChars: z.optional(z.number().check(z.int(), z.minimum(32), z.maximum(2000))),
}));
export type ExecutionRunTurnStreamStartRequest = z.infer<typeof ExecutionRunTurnStreamStartRequestSchema>;

export const ExecutionRunUserTranscriptDirectiveSchema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('persist'),
    localId: PendingLocalIdSchema,
  }),
  z.object({
    mode: z.literal('suppress'),
    /** Correlates provider input whose transcript was already committed by the caller. */
    localId: z.optional(PendingLocalIdSchema),
  }),
]));
export type ExecutionRunUserTranscriptDirective = z.infer<typeof ExecutionRunUserTranscriptDirectiveSchema>;

export const ExecutionRunTurnStreamStartV2RequestSchema = lazyZodSchema(() => z.extend(ExecutionRunTurnStreamStartRequestSchema, {
  userTranscript: ExecutionRunUserTranscriptDirectiveSchema,
}));
export type ExecutionRunTurnStreamStartV2Request = z.infer<typeof ExecutionRunTurnStreamStartV2RequestSchema>;

export const ExecutionRunTurnStreamStartResponseSchema = lazyZodSchema(() => z.looseObject({
  streamId: z.string().check(z.minLength(1)),
}));
export type ExecutionRunTurnStreamStartResponse = z.infer<typeof ExecutionRunTurnStreamStartResponseSchema>;

/**
 * Prospective predecessor vocabulary observed at
 * remote-dev@0649e4de85aacf08476063fef1990f418ce8e80b.
 */
export const ExecutionRunUserTranscriptCommitRequestSchema = lazyZodSchema(() => z.looseObject({
  runId: z.string().check(z.minLength(1)),
  message: z.string().check(z.minLength(1)),
  displayMessage: z.optional(z.string().check(z.minLength(1))),
  localId: PendingLocalIdSchema,
  text: z.optional(z.never()),
  displayText: z.optional(z.never()),
}));
export type ExecutionRunUserTranscriptCommitRequest = z.infer<typeof ExecutionRunUserTranscriptCommitRequestSchema>;

export const ExecutionRunUserTranscriptCommitResponseSchema = lazyZodSchema(() => z.looseObject({
  ok: z.literal(true),
}));
export type ExecutionRunUserTranscriptCommitResponse = z.infer<typeof ExecutionRunUserTranscriptCommitResponseSchema>;

export const ExecutionRunTurnStreamEventDeltaSchema = lazyZodSchema(() => z.looseObject({
  t: z.literal('delta'),
  textDelta: z.string(),
}));
export type ExecutionRunTurnStreamEventDelta = z.infer<typeof ExecutionRunTurnStreamEventDeltaSchema>;

export const ExecutionRunTurnStreamEventDoneSchema = lazyZodSchema(() => z.looseObject({
  t: z.literal('done'),
  assistantText: z.string(),
  actions: z.optional(z.array(VoiceAssistantActionSchema)),
}));
export type ExecutionRunTurnStreamEventDone = z.infer<typeof ExecutionRunTurnStreamEventDoneSchema>;

export const ExecutionRunTurnStreamEventErrorSchema = lazyZodSchema(() => z.looseObject({
  t: z.literal('error'),
  error: z.string(),
  errorCode: z.optional(z.string()),
  /** The native owner already redacted provider diagnostics; this stream is Account-carried. */
  runtimeIssueV1: z.optional(SessionRuntimeIssueV1Schema),
  /** Display facts only; the native Run retains recovery and credential selection. */
  usageLimitRecovery: z.optional(SessionUsageLimitRecoveryDisplayV1Schema),
  usageLimitResetAtMs: z.optional(SessionUsageLimitRecoveryDisplayV1Schema.shape.resetAtMs),
}));
export type ExecutionRunTurnStreamEventError = z.infer<typeof ExecutionRunTurnStreamEventErrorSchema>;

export const ExecutionRunTurnStreamEventCancelledSchema = lazyZodSchema(() => z.looseObject({
  t: z.literal('cancelled'),
}));
export type ExecutionRunTurnStreamEventCancelled = z.infer<typeof ExecutionRunTurnStreamEventCancelledSchema>;

export const ExecutionRunTurnStreamEventVoiceOutputSchema = lazyZodSchema(() => z.strictObject({
  t: z.literal('voice_output'),
  output: VoiceAgentOutputEventV1Schema,
}));
export type ExecutionRunTurnStreamEventVoiceOutput = z.infer<typeof ExecutionRunTurnStreamEventVoiceOutputSchema>;

export const ExecutionRunTurnStreamEventSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  ExecutionRunTurnStreamEventDeltaSchema,
  ExecutionRunTurnStreamEventDoneSchema,
  ExecutionRunTurnStreamEventErrorSchema,
  ExecutionRunTurnStreamEventCancelledSchema,
  ExecutionRunTurnStreamEventVoiceOutputSchema,
]));
export type ExecutionRunTurnStreamEvent = z.infer<typeof ExecutionRunTurnStreamEventSchema>;

export const ExecutionRunTurnStreamReadResponseSchema = lazyZodSchema(() => z.looseObject({
  streamId: z.string().check(z.minLength(1)),
  events: z.array(ExecutionRunTurnStreamEventSchema),
  nextCursor: z.number().check(z.int(), z.minimum(0)),
  done: z.boolean(),
  /** Successful supported prompt delivery for this exact stream, never a start-time claim. */
  preparedInstructionsFor: z.optional(ExecutionRunPreparedInstructionsForSchema),
}));
export type ExecutionRunTurnStreamReadResponse = z.infer<typeof ExecutionRunTurnStreamReadResponseSchema>;

export const ExecutionRunTurnStreamCancelRequestSchema = lazyZodSchema(() => z.looseObject({
  runId: z.string().check(z.minLength(1)),
  streamId: z.string().check(z.minLength(1)),
}));
export type ExecutionRunTurnStreamCancelRequest = z.infer<typeof ExecutionRunTurnStreamCancelRequestSchema>;

export const ExecutionRunTurnStreamCancelResponseSchema = lazyZodSchema(() => z.looseObject({
  ok: z.literal(true),
}));
export type ExecutionRunTurnStreamCancelResponse = z.infer<typeof ExecutionRunTurnStreamCancelResponseSchema>;
