import { z } from 'zod';

import { PendingRequestedActionV1Schema } from './pendingRequestedActionV1.js';
import { PendingLocalIdSchema } from './pendingLocalId.js';
import { PendingProviderActionSchema } from './pendingProviderAction.js';
import { SessionMessageDeliveryResolutionV1Schema } from './sessionMessageDeliveryResolutionV1.js';
import { SessionMessageRoleSchema } from './sessionMessageRole.js';
import { lazySchema } from '../lazySchema.js';

export const ACCEPTED_PENDING_SETTLEMENT_EVENT_V1 = 'pending-delivery-accepted-v1' as const;

const AcceptedPendingSettlementIdentitySchema = lazySchema(() => z.string().refine(
  (value) => value.trim().length > 0,
  { message: 'Settlement identity must not be blank' },
));

export const AcceptedPendingSettlementRequestV1Schema = lazySchema(() => z.object({
  v: z.literal(1),
  sessionId: AcceptedPendingSettlementIdentitySchema,
  localId: PendingLocalIdSchema,
}).strict());

export type AcceptedPendingSettlementRequestV1 = z.infer<typeof AcceptedPendingSettlementRequestV1Schema>;

export const AcceptedPendingSettlementRequestV2Schema = lazySchema(() => AcceptedPendingSettlementRequestV1Schema.extend({
  v: z.literal(2),
  outcome: z.literal('handed_off'),
}));

export type AcceptedPendingSettlementRequestV2 = z.infer<typeof AcceptedPendingSettlementRequestV2Schema>;

export const AcceptedPendingSettlementRequestSchema = lazySchema(() => z.discriminatedUnion('v', [
  AcceptedPendingSettlementRequestV1Schema,
  AcceptedPendingSettlementRequestV2Schema,
]));

const AcceptedPendingSettlementPendingCountSchema = lazySchema(() => z.number().int().nonnegative());

const AcceptedPendingSettlementStateSchema = {
  pendingCount: AcceptedPendingSettlementPendingCountSchema,
  pendingBlockedCount: AcceptedPendingSettlementPendingCountSchema,
  pendingVersion: AcceptedPendingSettlementPendingCountSchema,
} as const;

const AcceptedPendingSettlementMessageV1Schema = lazySchema(() => z.object({
  id: AcceptedPendingSettlementIdentitySchema,
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
    ...AcceptedPendingSettlementStateSchema,
    message: AcceptedPendingSettlementMessageV1Schema.optional(),
  }).strict(),
  z.object({
    ok: z.literal(true),
    didResolve: z.literal(true),
    ...AcceptedPendingSettlementStateSchema,
    message: AcceptedPendingSettlementMessageV1Schema,
  }).strict(),
]));

const AcceptedPendingSettlementFailureErrorSchema = lazySchema(() => z.enum([
  'session-not-found',
  'forbidden',
  'invalid-params',
  'not-found',
  'not-materialized',
  'blocked-by-earlier-pending',
  'transcript-conflict',
  'internal',
]));

const AcceptedPendingSettlementFailureSchema = lazySchema(() => z.discriminatedUnion('error', [
  z.object({
    ok: z.literal(false),
    error: AcceptedPendingSettlementFailureErrorSchema,
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
  AcceptedPendingSettlementFailureSchema,
]));

export type AcceptedPendingSettlementResponseV1 = z.infer<typeof AcceptedPendingSettlementResponseV1Schema>;


export const AcceptedPendingSettlementResponseV2Schema = lazySchema(() => z.union([
  z.object({
    ok: z.literal(true),
    didResolve: z.boolean(),
    ...AcceptedPendingSettlementStateSchema,
  }).strict(),
  AcceptedPendingSettlementFailureSchema,
]));

export type AcceptedPendingSettlementResponseV2 = z.infer<typeof AcceptedPendingSettlementResponseV2Schema>;
