import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const ActionSessionAddressV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.minLength(1)),
  sessionId: z.string().check(z.trim(), z.minLength(1)),
}));
export type ActionSessionAddressV1 = z.infer<typeof ActionSessionAddressV1Schema>;
