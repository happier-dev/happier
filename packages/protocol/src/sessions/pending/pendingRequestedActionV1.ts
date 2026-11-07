import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { UsageTimingBoundsV1Schema } from '../../usage/usageTimingV1.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { QualifiedConnectedServiceUsageSourceV4Schema } from '../../connect/qualifiedConnectedAccountProjectionsV4.js';
import { ProviderAccountUsageRecordIdSchema, ProviderAccountUsageHistoryWitnessV1Schema } from '../../connect/providerAccountUsagePrimitives.js';
import { SessionPendingWithdrawInputV1Schema, SessionPendingWithdrawResultV1Schema } from '../control/pendingWithdrawV1.js';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '../messages/sessionStoredMessageContent.js';

export const PendingRequestedActionKindV1Schema = lazyZodSchema(() => z.enum([
  'enqueue',
  'steer_if_active',
  'steer_now',
  'send_now',
  'reset_start',
]));

/** Only server-visible identity binds the hold; protected quota dates stay in B. */
export const PendingResetStartBindingV1Schema = lazyZodSchema(() => z.strictObject({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
  recordId: ProviderAccountUsageRecordIdSchema,
  meterId: z.string().check(z.minLength(1)),
  witness: ProviderAccountUsageHistoryWitnessV1Schema,
}));
export type PendingResetStartBindingV1 = z.infer<typeof PendingResetStartBindingV1Schema>;

const PendingOrdinaryRequestedActionV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), kind: z.enum(['enqueue', 'steer_if_active', 'steer_now', 'send_now']),
}));
export const PendingRequestedActionV1Schema = lazyZodSchema(() => z.union([
  PendingOrdinaryRequestedActionV1Schema,
  z.strictObject({ v: z.literal(1), kind: z.literal('reset_start'), reset: PendingResetStartBindingV1Schema }),
  // Recovery changes execution authority and cannot be ignored by a V1 reader.
  z.strictObject({ v: z.literal(2), kind: z.literal('recover_execution_run') }),
]));
export const PendingRequestedActionV1StoredSchema = createStoredReadSchema(PendingRequestedActionV1Schema);

export const PendingResetStartSetInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(SessionPendingWithdrawInputV1Schema, { targetExecutionRunId: true }), {
  reset: PendingResetStartBindingV1Schema,
  // Absence binds existing custody; presence admits one new input, already
  // sealed in the Session's canonical Pending envelope, with no ordinary-send state.
  initialInput: z.optional(z.strictObject({ content: StrictSessionStoredMessageContentEnvelopeSchema,
    usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)),
    targetMachineId: z.optional(z.string().check(z.trim(), z.minLength(1))) })),
})));
export const PendingResetStartCancelInputV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.omit(SessionPendingWithdrawInputV1Schema, { targetExecutionRunId: true })));
/** Existing-row intent/rearm only; reset holds keep their witnessed admission Action. */
export const SessionPendingActionSetInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionPendingWithdrawInputV1Schema.shape.sessionId,
  localId: SessionPendingWithdrawInputV1Schema.shape.localId,
  serverId: SessionPendingWithdrawInputV1Schema.shape.serverId,
  requestedAction: PendingOrdinaryRequestedActionV1Schema,
  resumeWhenAvailable: z.optional(z.boolean()),
}));
export const SessionPendingActionSetResultV1Schema = lazyZodSchema(() => z.strictObject({
  didUpdate: z.boolean(), requestedAction: PendingRequestedActionV1Schema,
}));
export type SessionPendingActionSetInputV1 = z.infer<typeof SessionPendingActionSetInputV1Schema>;
export type SessionPendingActionSetResultV1 = z.infer<typeof SessionPendingActionSetResultV1Schema>;
export const PendingResetStartSetResultV1Schema = SessionPendingActionSetResultV1Schema;
export const PendingResetStartCancelResultV1Schema = lazyZodSchema(() => SessionPendingWithdrawResultV1Schema);
export type PendingResetStartSetInputV1 = z.infer<typeof PendingResetStartSetInputV1Schema>;
export type PendingResetStartCancelInputV1 = z.infer<typeof PendingResetStartCancelInputV1Schema>;
export type PendingResetStartSetResultV1 = z.infer<typeof PendingResetStartSetResultV1Schema>;
export type PendingResetStartCancelResultV1 = z.infer<typeof PendingResetStartCancelResultV1Schema>;

export const SESSION_PENDING_RESET_START_RELEASE_EVENT_V1 = 'session-pending-reset-start-release-v1' as const;
export const PendingResetStartReleaseRequestV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PendingResetStartCancelInputV1Schema, { serverId: true }), {
  v: z.literal(1), reset: PendingResetStartBindingV1Schema,
})));
export const PendingResetStartReleaseResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.strictObject({ v: z.literal(1), ok: z.literal(true), didUpdate: z.boolean() }),
  z.strictObject({ v: z.literal(1), ok: z.literal(false), reason: z.enum(['invalid_request', 'authority_unavailable', 'action_conflict', 'pending_not_found', 'internal_error']) }),
]));
export type PendingResetStartReleaseRequestV1 = z.infer<typeof PendingResetStartReleaseRequestV1Schema>;
export type PendingResetStartReleaseResponseV1 = z.infer<typeof PendingResetStartReleaseResponseV1Schema>;

export const PendingResetStartsReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
}));
export const PendingResetStartsReadResultV1Schema = lazyZodSchema(() => z.strictObject({
  entries: z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PendingResetStartCancelInputV1Schema, { serverId: true }), {
    reset: PendingResetStartBindingV1Schema,
    authorityCurrent: z.boolean(),
  }))),
  // Optional on the wire so a current reader still accepts an older reset reader.
  // No prompt content is returned by the Account-wide projection.
  unboundEntries: z.optional(z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(PendingResetStartCancelInputV1Schema, { serverId: true }), {
    authorityCurrent: z.boolean(),
  })))),
}));
export type PendingResetStartsReadInputV1 = z.infer<typeof PendingResetStartsReadInputV1Schema>;
export type PendingResetStartsReadResultV1 = z.infer<typeof PendingResetStartsReadResultV1Schema>;

export type PendingRequestedActionKindV1 = z.infer<typeof PendingRequestedActionKindV1Schema>;
export type PendingRequestedActionV1 = z.infer<typeof PendingRequestedActionV1Schema>;

export const DEFAULT_PENDING_REQUESTED_ACTION_V1 = Object.freeze({
  v: 1,
  kind: 'enqueue',
} satisfies PendingRequestedActionV1);

export function normalizePendingRequestedActionV1(value: unknown, source: 'input' | 'stored' = 'input'): PendingRequestedActionV1 {
  if (value === null || value === undefined) {
    return DEFAULT_PENDING_REQUESTED_ACTION_V1;
  }
  const parsed = (source === 'stored' ? PendingRequestedActionV1StoredSchema : PendingRequestedActionV1Schema).safeParse(value);
  if (!parsed.success) {
    throw new Error('Malformed non-null Pending requested action');
  }
  return parsed.data;
}
