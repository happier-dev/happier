import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { TurnIdSchema } from './idsV1.js';
import { FollowEventV1Schema } from './follow/sessionFollowPolicyV1.js';

export const SessionUserActionRequiredRequestKindV1Schema = lazyZodSchema(() => z.enum([
  'permission',
  'user_action',
]));
export type SessionUserActionRequiredRequestKindV1 = z.infer<
  typeof SessionUserActionRequiredRequestKindV1Schema
>;

/** Content-free identity for one newly pending main-turn request. */
export const SessionUserActionRequiredOccurrenceV1Schema = lazyZodSchema(() => z.strictObject({
  requestId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
  sourceTurnId: TurnIdSchema,
  requestKind: SessionUserActionRequiredRequestKindV1Schema,
  occurredAt: z.number().check(z.int(), z.nonnegative()),
  /** Non-content operational intent projected by the request owner. */
  followEvent: z.optional(FollowEventV1Schema),
}).check(z.superRefine((value, context) => {
  if (value.followEvent && (value.followEvent.kind !== 'needs_you'
    || value.requestKind === 'permission' && value.followEvent.type !== 'approval')) {
    context.addIssue({ code: 'custom', path: ['followEvent'], message: 'Request delivery intent must match its source kind.' });
  }
})));
export type SessionUserActionRequiredOccurrenceV1 = z.infer<
  typeof SessionUserActionRequiredOccurrenceV1Schema
>;
