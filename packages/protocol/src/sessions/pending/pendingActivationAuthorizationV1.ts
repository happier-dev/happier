import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { ManagedWakeTargetV1Schema } from '../../machines/managed/managedIntentV1.js';
import { SessionInputMachineTargetV1Schema } from '../messages/sessionInputAdmission.js';

export const PendingActivationFailureCodeV1Schema = lazyZodSchema(() => z.enum(['runtime_start_failed']));
export type PendingActivationFailureCodeV1 = z.infer<typeof PendingActivationFailureCodeV1Schema>;

const PendingActivationAuthorizationBaseV1Schema = lazyZodSchema(() => z.object({
  requestId: z.string().trim().min(1),
  requestedAt: z.number().int().nonnegative(),
  managedWakeTargetV1: z.optional(ManagedWakeTargetV1Schema),
  admittedTarget: SessionInputMachineTargetV1Schema.optional(),
}));

export const PendingActivationAuthorizationV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  PendingActivationAuthorizationBaseV1Schema.extend({ status: z.literal('waiting') }).strict(),
  PendingActivationAuthorizationBaseV1Schema.extend({
    status: z.literal('failed'),
    failureCode: PendingActivationFailureCodeV1Schema,
  }).strict(),
]));
export type PendingActivationAuthorizationV1 = z.infer<typeof PendingActivationAuthorizationV1Schema>;

export const PendingActivationFailureRequestV1Schema = lazyZodSchema(() => z.object({
  requestId: z.string().trim().min(1),
  requestedAt: z.number().int().nonnegative(),
  failureCode: PendingActivationFailureCodeV1Schema,
}).strict());
export type PendingActivationFailureRequestV1 = z.infer<typeof PendingActivationFailureRequestV1Schema>;

/** Installation-signed controller report; the target reference is not bearer authority. */
export const ManagedPendingActivationFailureRequestV1Schema = lazyZodSchema(() => z.object({
  target: ManagedWakeTargetV1Schema,
  failureCode: PendingActivationFailureCodeV1Schema,
}).strict().refine(value => value.target.origin.kind === 'session-input'));
export type ManagedPendingActivationFailureRequestV1 = z.infer<typeof ManagedPendingActivationFailureRequestV1Schema>;

export const PendingActivationFailureResponseV1Schema = lazyZodSchema(() => z.object({
  ok: z.literal(true),
  didFail: z.boolean(),
}).strict());
export type PendingActivationFailureResponseV1 = z.infer<typeof PendingActivationFailureResponseV1Schema>;

/** Only a confirmed owner removal permits restoring the original input as a draft. */
export const PendingMessageWithdrawOutcomeV1Schema = lazyZodSchema(() => z.enum([
  'removed', 'already_delivered', 'delivery_unknown',
]));
export type PendingMessageWithdrawOutcomeV1 = z.infer<typeof PendingMessageWithdrawOutcomeV1Schema>;
