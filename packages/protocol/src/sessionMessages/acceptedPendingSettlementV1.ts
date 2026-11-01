import { z } from 'zod';

import { PendingRequestedActionV1Schema } from './pendingRequestedActionV1.js';
import { PendingLocalIdSchema } from './pendingLocalId.js';
import { PendingProviderActionSchema } from './pendingProviderAction.js';
import { SessionMessageDeliveryResolutionV1Schema } from './sessionMessageDeliveryResolutionV1.js';
import { SessionMessageRoleSchema } from './sessionMessageRole.js';
import { lazySchema } from '../lazySchema.js';

export const ACCEPTED_PENDING_SETTLEMENT_EVENT_V1 = 'pending-delivery-accepted-v1' as const;

const AcceptedPendingSettlementIdentityV1Schema = lazySchema(() => z.string().refine(
  (value) => value.trim().length > 0,
  { message: 'Settlement identity must not be blank' },
));

export const AcceptedPendingSettlementRequestV1Schema = lazySchema(() => z.object({
  v: z.literal(1),
  sessionId: AcceptedPendingSettlementIdentityV1Schema,
  localId: PendingLocalIdSchema,
}).strict());

export type AcceptedPendingSettlementRequestV1 = z.infer<typeof AcceptedPendingSettlementRequestV1Schema>;

const AcceptedPendingSettlementPendingCountV1Schema = lazySchema(() => z.number().int().nonnegative());

const AcceptedPendingSettlementStateV1Schema = {
  pendingCount: AcceptedPendingSettlementPendingCountV1Schema,
  pendingBlockedCount: AcceptedPendingSettlementPendingCountV1Schema,
  pendingVersion: AcceptedPendingSettlementPendingCountV1Schema,
} as const;

const AcceptedPendingSettlementMessageV1Schema = lazySchema(() => z.object({
  id: AcceptedPendingSettlementIdentityV1Schema,
  seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  localId: PendingLocalIdSchema,
  messageRole: SessionMessageRoleSchema.optional(),
  content: z.json(),
  requestedAction: PendingRequestedActionV1Schema.optional(),
  providerAction: PendingProviderActionSchema.optional(),
  deliveryResolution: SessionMessageDeliveryResolutionV1Schema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict());

const AcceptedPendingSettlementSuccessV1Schema = lazySchema(() => z.discriminatedUnion('didResolve', [
  z.object({
    ok: z.literal(true),
    didResolve: z.literal(false),
    ...AcceptedPendingSettlementStateV1Schema,
    message: AcceptedPendingSettlementMessageV1Schema.optional(),
  }).strict(),
  z.object({
    ok: z.literal(true),
    didResolve: z.literal(true),
    ...AcceptedPendingSettlementStateV1Schema,
    message: AcceptedPendingSettlementMessageV1Schema,
  }).strict(),
]));

const AcceptedPendingSettlementFailureErrorV1Schema = lazySchema(() => z.enum([
  'session-not-found',
  'forbidden',
  'invalid-params',
  'not-found',
  'not-materialized',
  'blocked-by-earlier-pending',
  'transcript-conflict',
  'internal',
]));

const AcceptedPendingSettlementFailureV1Schema = lazySchema(() => z.discriminatedUnion('error', [
  z.object({
    ok: z.literal(false),
    error: AcceptedPendingSettlementFailureErrorV1Schema,
  }).strict(),
  z.object({
    ok: z.literal(false),
    error: z.literal('transaction-unavailable'),
    retryAfterMs: z.number().int().nonnegative(),
    correlationId: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/u).optional(),
  }).strict(),
]));

export const AcceptedPendingSettlementResponseV1Schema = lazySchema(() => z.union([
  AcceptedPendingSettlementSuccessV1Schema,
  AcceptedPendingSettlementFailureV1Schema,
]));

export type AcceptedPendingSettlementResponseV1 = z.infer<typeof AcceptedPendingSettlementResponseV1Schema>;
