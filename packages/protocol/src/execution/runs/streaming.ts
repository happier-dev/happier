import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { VoiceAssistantActionSchema } from '../../voice/actions.js';
import { VoiceAgentOutputEventV1Schema } from '../../voice/outputEvents.js';
import { PendingLocalIdSchema } from '../../sessions/pending/pendingLocalId.js';

export {
  ExecutionRunTurnStreamReadRequestSchema,
  type ExecutionRunTurnStreamReadRequest,
} from './runPrimitives.js';

// Streaming turn IO (V1: used for intent='voice_agent').
export const ExecutionRunTurnStreamStartRequestSchema = lazyZodSchema(() => z.object({
  runId: z.string().min(1),
  message: z.string().min(1),
  displayMessage: z.string().min(1).optional(),
  resume: z.boolean().optional(),
  /** Voice latency preference; provider request-size limits remain separate. */
  speechSegmentTargetChars: z.number().int().min(32).max(2000).optional(),
}).passthrough());
export type ExecutionRunTurnStreamStartRequest = z.infer<typeof ExecutionRunTurnStreamStartRequestSchema>;

export const ExecutionRunUserTranscriptDirectiveSchema = lazyZodSchema(() => z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('persist'),
    localId: PendingLocalIdSchema,
  }),
  z.object({
    mode: z.literal('suppress'),
    /** Correlates provider input whose transcript was already committed by the caller. */
    localId: PendingLocalIdSchema.optional(),
  }),
]));
export type ExecutionRunUserTranscriptDirective = z.infer<typeof ExecutionRunUserTranscriptDirectiveSchema>;

export const ExecutionRunTurnStreamStartV2RequestSchema = lazyZodSchema(() => ExecutionRunTurnStreamStartRequestSchema.extend({
  userTranscript: ExecutionRunUserTranscriptDirectiveSchema,
}));
export type ExecutionRunTurnStreamStartV2Request = z.infer<typeof ExecutionRunTurnStreamStartV2RequestSchema>;

export const ExecutionRunTurnStreamStartResponseSchema = lazyZodSchema(() => z.object({
  streamId: z.string().min(1),
}).passthrough());
export type ExecutionRunTurnStreamStartResponse = z.infer<typeof ExecutionRunTurnStreamStartResponseSchema>;

/**
 * Prospective predecessor vocabulary observed at
 * remote-dev@0649e4de85aacf08476063fef1990f418ce8e80b.
 */
export const ExecutionRunUserTranscriptCommitRequestSchema = lazyZodSchema(() => z.object({
  runId: z.string().min(1),
  message: z.string().min(1),
  displayMessage: z.string().min(1).optional(),
  localId: PendingLocalIdSchema,
  text: z.never().optional(),
  displayText: z.never().optional(),
}).passthrough());
export type ExecutionRunUserTranscriptCommitRequest = z.infer<typeof ExecutionRunUserTranscriptCommitRequestSchema>;

export const ExecutionRunUserTranscriptCommitResponseSchema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
}).passthrough());
export type ExecutionRunUserTranscriptCommitResponse = z.infer<typeof ExecutionRunUserTranscriptCommitResponseSchema>;

export const ExecutionRunTurnStreamEventDeltaSchema = lazyZodSchema(() => z.object({
  t: z.literal('delta'),
  textDelta: z.string(),
}).passthrough());
export type ExecutionRunTurnStreamEventDelta = z.infer<typeof ExecutionRunTurnStreamEventDeltaSchema>;

export const ExecutionRunTurnStreamEventDoneSchema = lazyZodSchema(() => z.object({
  t: z.literal('done'),
  assistantText: z.string(),
  actions: z.array(VoiceAssistantActionSchema).optional(),
}).passthrough());
export type ExecutionRunTurnStreamEventDone = z.infer<typeof ExecutionRunTurnStreamEventDoneSchema>;

export const ExecutionRunTurnStreamEventErrorSchema = lazyZodSchema(() => z.object({
  t: z.literal('error'),
  error: z.string(),
  errorCode: z.string().optional(),
}).passthrough());
export type ExecutionRunTurnStreamEventError = z.infer<typeof ExecutionRunTurnStreamEventErrorSchema>;

export const ExecutionRunTurnStreamEventCancelledSchema = lazyZodSchema(() => z.object({
  t: z.literal('cancelled'),
}).passthrough());
export type ExecutionRunTurnStreamEventCancelled = z.infer<typeof ExecutionRunTurnStreamEventCancelledSchema>;

export const ExecutionRunTurnStreamEventVoiceOutputSchema = lazyZodSchema(() => z.object({
  t: z.literal('voice_output'),
  output: VoiceAgentOutputEventV1Schema,
}).strict());
export type ExecutionRunTurnStreamEventVoiceOutput = z.infer<typeof ExecutionRunTurnStreamEventVoiceOutputSchema>;

export const ExecutionRunTurnStreamEventSchema = lazyZodSchema(() => z.discriminatedUnion('t', [
  ExecutionRunTurnStreamEventDeltaSchema,
  ExecutionRunTurnStreamEventDoneSchema,
  ExecutionRunTurnStreamEventErrorSchema,
  ExecutionRunTurnStreamEventCancelledSchema,
  ExecutionRunTurnStreamEventVoiceOutputSchema,
]));
export type ExecutionRunTurnStreamEvent = z.infer<typeof ExecutionRunTurnStreamEventSchema>;

export const ExecutionRunTurnStreamReadResponseSchema = lazyZodSchema(() => z.object({
  streamId: z.string().min(1),
  events: z.array(ExecutionRunTurnStreamEventSchema),
  nextCursor: z.number().int().min(0),
  done: z.boolean(),
}).passthrough());
export type ExecutionRunTurnStreamReadResponse = z.infer<typeof ExecutionRunTurnStreamReadResponseSchema>;

export const ExecutionRunTurnStreamCancelRequestSchema = lazyZodSchema(() => z.object({
  runId: z.string().min(1),
  streamId: z.string().min(1),
}).passthrough());
export type ExecutionRunTurnStreamCancelRequest = z.infer<typeof ExecutionRunTurnStreamCancelRequestSchema>;

export const ExecutionRunTurnStreamCancelResponseSchema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
}).passthrough());
export type ExecutionRunTurnStreamCancelResponse = z.infer<typeof ExecutionRunTurnStreamCancelResponseSchema>;
