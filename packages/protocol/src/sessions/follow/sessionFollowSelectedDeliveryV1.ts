import { z } from 'zod/mini';

import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Leaf module: Follow witness, input and transport schemas import this without entering the policy module cycle. */
export const SessionFollowSelectedDeliveryV1Schema = lazyZodSchema(() => z.enum(['wake', 'next_turn']));
export type SessionFollowSelectedDeliveryV1 = z.infer<typeof SessionFollowSelectedDeliveryV1Schema>;
