import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { UsageTimingBoundsV1Schema } from '../../usage/usageTimingV1.js';

import { SessionMessageAcceptedDeliveryContentV1Schema, SessionMessageAcceptedTurnV1Schema, SessionMessageDeliveryResolutionV1Schema } from '../messages/sessionMessageDeliveryResolutionV1.js';
import { SessionMessageRoleSchema } from '../messages/sessionMessageRole.js';
import { PendingLocalIdSchema } from './pendingLocalId.js';
import { PendingProviderActionSchema } from './pendingProviderAction.js';
import { PendingRequestedActionV1Schema } from './pendingRequestedActionV1.js';

export const ACCEPTED_PENDING_SETTLEMENT_EVENT_V1 = 'pending-delivery-accepted-v1' as const;

const SettlementIdentityV1Schema = lazyZodSchema(() => z.string().check(z.refine((value) => value.trim().length > 0, {
  message: 'Settlement identity must not be blank',
})));

export const AcceptedPendingSettlementRequestV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  sessionId: SettlementIdentityV1Schema,
  localId: PendingLocalIdSchema,
  acceptedDelivery: z.optional(SessionMessageAcceptedDeliveryContentV1Schema),
  /** Added delivery component only; settlement merges with retained whole-message timing. */
  usageTimingV1: z.optional(z.nullable(UsageTimingBoundsV1Schema)),
  /** Clear host-stamped projection; content may remain encrypted for the Account. */
  acceptedTurn: z.optional(SessionMessageAcceptedTurnV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.acceptedDelivery?.t !== 'plain' || value.acceptedTurn === undefined) return;
  const delivery = value.acceptedDelivery.v.delivery;
  if (delivery.kind !== value.acceptedTurn.kind || delivery.turnId !== value.acceptedTurn.turnId) {
    context.addIssue({ code: 'custom', path: ['acceptedTurn'], message: 'Accepted turn differs from plain delivery' });
  }
})));

const PendingCountV1Schema = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const SettlementStateV1Schema = {
  pendingCount: PendingCountV1Schema,
  pendingBlockedCount: PendingCountV1Schema,
  pendingVersion: PendingCountV1Schema,
} as const;

const AcceptedPendingSettlementMessageV1Schema = lazyZodSchema(() => z.strictObject({
  id: SettlementIdentityV1Schema,
  seq: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  localId: PendingLocalIdSchema,
  messageRole: z.optional(SessionMessageRoleSchema),
  content: z.json(),
  requestedAction: z.optional(PendingRequestedActionV1Schema),
  providerAction: z.optional(PendingProviderActionSchema),
  deliveryResolution: z.optional(SessionMessageDeliveryResolutionV1Schema),
  createdAt: z.number().check(z.int(), z.nonnegative()),
  updatedAt: z.number().check(z.int(), z.nonnegative()),
}));

const AcceptedPendingSettlementSuccessV1Schema = lazyZodSchema(() => z.discriminatedUnion('didResolve', [
  z.strictObject({
    ok: z.literal(true),
    didResolve: z.literal(false),
    ...SettlementStateV1Schema,
    message: z.optional(AcceptedPendingSettlementMessageV1Schema),
  }),
  z.strictObject({
    ok: z.literal(true),
    didResolve: z.literal(true),
    ...SettlementStateV1Schema,
    message: AcceptedPendingSettlementMessageV1Schema,
  }),
]));

const AcceptedPendingSettlementFailureErrorV1Schema = lazyZodSchema(() => z.enum([
    'session-not-found',
    'forbidden',
    'invalid-params',
    'not-found',
    'not-materialized',
    'turn-publication-pending',
    'blocked-by-earlier-pending',
    'transcript-conflict',
    'internal',
]));

const AcceptedPendingSettlementFailureV1Schema = lazyZodSchema(() => z.discriminatedUnion('error', [
  z.strictObject({
    ok: z.literal(false),
    error: AcceptedPendingSettlementFailureErrorV1Schema,
  }),
  z.strictObject({
    ok: z.literal(false),
    error: z.literal('transaction-unavailable'),
    retryAfterMs: z.number().check(z.int(), z.nonnegative()),
    correlationId: z.optional(z.string().check(z.regex(/^[A-Za-z0-9_.:-]{1,160}$/u))),
  }),
]));

export const AcceptedPendingSettlementResponseV1Schema = lazyZodSchema(() => z.union([
  AcceptedPendingSettlementSuccessV1Schema,
  AcceptedPendingSettlementFailureV1Schema,
]));

export type AcceptedPendingSettlementRequestV1 = z.infer<typeof AcceptedPendingSettlementRequestV1Schema>;
export type AcceptedPendingSettlementResponseV1 = z.infer<typeof AcceptedPendingSettlementResponseV1Schema>;
