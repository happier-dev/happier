import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { QualifiedConnectedServiceUsageSourceV4Schema } from '../../connect/qualifiedConnectedAccountProjectionsV4.js';
import { ProviderAccountUsageRecordIdSchema, ProviderAccountUsageHistoryWitnessV1Schema } from '../../connect/providerAccountUsagePrimitives.js';
import { SessionPendingWithdrawInputV1Schema, SessionPendingWithdrawResultV1Schema } from '../control/pendingWithdrawV1.js';

export const PendingRequestedActionKindV1Schema = lazyZodSchema(() => z.enum([
  'enqueue',
  'steer_if_active',
  'steer_now',
  'send_now',
  'reset_start',
]));

/** Only server-visible identity binds the hold; protected quota dates stay in B. */
export const PendingResetStartBindingV1Schema = lazyZodSchema(() => z.object({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
  recordId: ProviderAccountUsageRecordIdSchema,
  meterId: z.string().min(1),
  witness: ProviderAccountUsageHistoryWitnessV1Schema,
}).strict());
export type PendingResetStartBindingV1 = z.infer<typeof PendingResetStartBindingV1Schema>;

export const PendingRequestedActionV1Schema = lazyZodSchema(() => z.union([
  z.object({ v: z.literal(1), kind: z.enum(['enqueue', 'steer_if_active', 'steer_now', 'send_now']) }).strict(),
  z.object({ v: z.literal(1), kind: z.literal('reset_start'), reset: PendingResetStartBindingV1Schema }).strict(),
]));

export const PendingResetStartSetInputV1Schema = lazyZodSchema(() => SessionPendingWithdrawInputV1Schema.omit({ targetExecutionRunId: true }).extend({
  reset: PendingResetStartBindingV1Schema,
}).strict());
export const PendingResetStartCancelInputV1Schema = lazyZodSchema(() => SessionPendingWithdrawInputV1Schema.omit({ targetExecutionRunId: true }).strict());
export const PendingResetStartSetResultV1Schema = lazyZodSchema(() => z.object({
  didUpdate: z.boolean(), requestedAction: PendingRequestedActionV1Schema,
}).strict());
export const PendingResetStartCancelResultV1Schema = lazyZodSchema(() => SessionPendingWithdrawResultV1Schema);
export type PendingResetStartSetInputV1 = z.infer<typeof PendingResetStartSetInputV1Schema>;
export type PendingResetStartCancelInputV1 = z.infer<typeof PendingResetStartCancelInputV1Schema>;
export type PendingResetStartSetResultV1 = z.infer<typeof PendingResetStartSetResultV1Schema>;
export type PendingResetStartCancelResultV1 = z.infer<typeof PendingResetStartCancelResultV1Schema>;

export const SESSION_PENDING_RESET_START_RELEASE_EVENT_V1 = 'session-pending-reset-start-release-v1' as const;
export const PendingResetStartReleaseRequestV1Schema = lazyZodSchema(() => PendingResetStartCancelInputV1Schema.omit({ serverId: true }).extend({
  v: z.literal(1), reset: PendingResetStartBindingV1Schema,
}).strict());
export const PendingResetStartReleaseResponseV1Schema = lazyZodSchema(() => z.discriminatedUnion('ok', [
  z.object({ v: z.literal(1), ok: z.literal(true), didUpdate: z.boolean() }).strict(),
  z.object({ v: z.literal(1), ok: z.literal(false), reason: z.enum(['invalid_request', 'authority_unavailable', 'action_conflict', 'pending_not_found', 'internal_error']) }).strict(),
]));
export type PendingResetStartReleaseRequestV1 = z.infer<typeof PendingResetStartReleaseRequestV1Schema>;
export type PendingResetStartReleaseResponseV1 = z.infer<typeof PendingResetStartReleaseResponseV1Schema>;

export const PendingResetStartsReadInputV1Schema = lazyZodSchema(() => z.object({
  source: QualifiedConnectedServiceUsageSourceV4Schema,
}).strict());
export const PendingResetStartsReadResultV1Schema = lazyZodSchema(() => z.object({
  entries: z.array(PendingResetStartCancelInputV1Schema.omit({ serverId: true }).extend({
    reset: PendingResetStartBindingV1Schema,
    authorityCurrent: z.boolean(),
  }).strict()),
}).strict());
export type PendingResetStartsReadInputV1 = z.infer<typeof PendingResetStartsReadInputV1Schema>;
export type PendingResetStartsReadResultV1 = z.infer<typeof PendingResetStartsReadResultV1Schema>;

export type PendingRequestedActionKindV1 = z.infer<typeof PendingRequestedActionKindV1Schema>;
export type PendingRequestedActionV1 = z.infer<typeof PendingRequestedActionV1Schema>;

export const DEFAULT_PENDING_REQUESTED_ACTION_V1 = Object.freeze({
  v: 1,
  kind: 'enqueue',
} satisfies PendingRequestedActionV1);

export function normalizePendingRequestedActionV1(value: unknown): PendingRequestedActionV1 {
  if (value === null || value === undefined) {
    return DEFAULT_PENDING_REQUESTED_ACTION_V1;
  }
  const parsed = PendingRequestedActionV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Malformed non-null Pending requested action');
  }
  return parsed.data;
}
