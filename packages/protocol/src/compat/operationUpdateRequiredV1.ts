import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const OperationUpdateRequiredV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('update_required'),
  operation: z.string().check(z.minLength(1)),
  component: z.enum(['server', 'daemon', 'client']),
  reason: z.string().check(z.minLength(1)),
}));
export type OperationUpdateRequiredV1 = z.infer<typeof OperationUpdateRequiredV1Schema>;
