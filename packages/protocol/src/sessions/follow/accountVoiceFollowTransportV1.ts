import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { SessionFollowFrontierV1Schema } from './sessionFollowFrontierV1.js';
import { FollowPolicyV1Schema } from './sessionFollowPolicyV1.js';

const SessionIdZodSchema = asProtocolZod(SessionIdSchema);
const PublisherGenerationV1Schema = lazyZodSchema(() => z.string().check(z.regex(/^(?:0|[1-9]\d{0,18})$/u), z.refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n)));
const AcceptanceSchema = lazyZodSchema(() => z.strictObject({
  localInputId: z.string().check(z.trim(), z.minLength(1)),
  userMessageSeq: z.nullable(z.number().check(z.int(), z.nonnegative())),
}));
const ExecutionRunIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(512)));
const ExecutionRunOccurrenceIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(512)));

export const ACCOUNT_VOICE_FOLLOW_OBSERVE_PENDING_EVENT_V1 = 'account-voice-follow-observe-pending-v1' as const;
export const ACCOUNT_VOICE_FOLLOW_ACKNOWLEDGE_EVENT_V1 = 'account-voice-follow-acknowledge-v1' as const;

export const AccountVoiceFollowPendingObservationV1Schema = lazyZodSchema(() => z.strictObject({
  sourceSessionId: SessionIdZodSchema,
  voiceSessionId: SessionIdZodSchema,
  expected: z.nullable(SessionFollowFrontierV1Schema),
  observed: SessionFollowFrontierV1Schema,
  /** Absent only for the independent legacy include-in-Voice ingress. */
  policy: z.optional(FollowPolicyV1Schema),
}));
export type AccountVoiceFollowPendingObservationV1 = z.infer<typeof AccountVoiceFollowPendingObservationV1Schema>;

export const AccountVoiceFollowObservePendingRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  voiceSessionId: SessionIdZodSchema,
  executionRunId: ExecutionRunIdSchema,
}));

export const AccountVoiceFollowObservePendingResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    v: z.literal(1),
    voiceSessionId: SessionIdZodSchema,
    publisherGeneration: PublisherGenerationV1Schema,
    executionRunOccurrenceId: ExecutionRunOccurrenceIdSchema,
    observations: z.array(AccountVoiceFollowPendingObservationV1Schema),
  }),
  z.strictObject({
    ok: z.literal(false),
    v: z.literal(1),
    error: z.enum(['invalid_request', 'forbidden', 'unsupported', 'internal']),
  }),
]));
export type AccountVoiceFollowObservePendingResponseV1 = z.infer<typeof AccountVoiceFollowObservePendingResponseV1Schema>;

export const AccountVoiceFollowAcknowledgeRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  voiceSessionId: SessionIdZodSchema,
  executionRunId: ExecutionRunIdSchema,
  expectedExecutionRunOccurrenceId: ExecutionRunOccurrenceIdSchema,
  sourceSessionId: SessionIdZodSchema,
  expectedPublisherGeneration: PublisherGenerationV1Schema,
  expected: z.nullable(SessionFollowFrontierV1Schema),
  observed: SessionFollowFrontierV1Schema,
  consumed: SessionFollowFrontierV1Schema,
  policy: z.optional(FollowPolicyV1Schema),
  acceptance: AcceptanceSchema,
}).check(z.superRefine((value, context) => {
  if (value.sourceSessionId === value.voiceSessionId) {
    context.addIssue({ code: 'custom', path: ['sourceSessionId'], message: 'Voice Follow requires distinct Sessions' });
  }
})));
export type AccountVoiceFollowAcknowledgeRequestV1 = z.infer<typeof AccountVoiceFollowAcknowledgeRequestV1Schema>;

export const AccountVoiceFollowAcknowledgeResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    v: z.literal(1),
    voiceSessionId: SessionIdZodSchema,
    sourceSessionId: SessionIdZodSchema,
    delivered: SessionFollowFrontierV1Schema,
  }),
  z.strictObject({
    ok: z.literal(false),
    v: z.literal(1),
    error: z.enum([
      'invalid_request', 'forbidden', 'not_followed', 'session_archived',
      'stale_publisher_generation', 'stale_expected_frontier', 'stale_terminal_turn',
      'invalid_consumed_frontier', 'provider_acceptance_unverified',
      'source_forbidden', 'unsupported', 'internal',
    ]),
  }),
]));
export type AccountVoiceFollowAcknowledgeResponseV1 = z.infer<typeof AccountVoiceFollowAcknowledgeResponseV1Schema>;
