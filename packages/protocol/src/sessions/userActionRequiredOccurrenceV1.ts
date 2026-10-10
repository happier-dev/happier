import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { TurnIdSchema } from './idsV1.js';

export const SessionUserActionRequiredRequestKindV1Schema = lazyZodSchema(() => z.enum([
  'permission',
  'user_action',
]));
export type SessionUserActionRequiredRequestKindV1 = z.infer<
  typeof SessionUserActionRequiredRequestKindV1Schema
>;

/** Content-free identity for one newly pending main-turn request. */
export const SessionUserActionRequiredOccurrenceV1Schema = lazyZodSchema(() => z.object({
  requestId: z.string().trim().min(1).max(256),
  sourceTurnId: TurnIdSchema,
  requestKind: SessionUserActionRequiredRequestKindV1Schema,
  occurredAt: z.number().int().nonnegative(),
}).strict());
export type SessionUserActionRequiredOccurrenceV1 = z.infer<
  typeof SessionUserActionRequiredOccurrenceV1Schema
>;
