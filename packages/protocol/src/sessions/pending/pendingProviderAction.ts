import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const PendingProviderActionSchema = lazyZodSchema(() => z.enum([
  'send',
  'steer',
  'interrupt_and_send',
]));

export type PendingProviderAction = z.infer<typeof PendingProviderActionSchema>;
