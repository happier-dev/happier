import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const OperationUpdateRequiredV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('update_required'),
  operation: z.string().min(1),
  component: z.enum(['server', 'daemon', 'client']),
  reason: z.string().min(1),
}).strict());
export type OperationUpdateRequiredV1 = z.infer<typeof OperationUpdateRequiredV1Schema>;
