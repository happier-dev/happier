import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const PendingActivationFailureCodeV1Schema = lazySchema(() => z.enum(['runtime_start_failed']));
export type PendingActivationFailureCodeV1 = z.infer<typeof PendingActivationFailureCodeV1Schema>;

const PendingActivationAuthorizationBaseV1Schema = lazySchema(() => z.object({
  requestId: z.string().trim().min(1),
  requestedAt: z.number().int().nonnegative(),
}));

export const PendingActivationAuthorizationV1Schema = lazySchema(() => z.discriminatedUnion('status', [
  PendingActivationAuthorizationBaseV1Schema.extend({ status: z.literal('waiting') }).strict(),
  PendingActivationAuthorizationBaseV1Schema.extend({
    status: z.literal('failed'),
    failureCode: PendingActivationFailureCodeV1Schema,
  }).strict(),
]));
export type PendingActivationAuthorizationV1 = z.infer<typeof PendingActivationAuthorizationV1Schema>;

export const PendingActivationFailureRequestV1Schema = lazySchema(() => z.object({
  requestId: z.string().trim().min(1),
  requestedAt: z.number().int().nonnegative(),
  failureCode: PendingActivationFailureCodeV1Schema,
}).strict());
export type PendingActivationFailureRequestV1 = z.infer<typeof PendingActivationFailureRequestV1Schema>;

export const PendingActivationFailureResponseV1Schema = lazySchema(() => z.object({
  ok: z.literal(true),
  didFail: z.boolean(),
}).strict());
export type PendingActivationFailureResponseV1 = z.infer<typeof PendingActivationFailureResponseV1Schema>;
