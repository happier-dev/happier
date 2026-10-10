import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const PendingProviderActionSchema = lazyZodSchema(() => z.enum([
  'send',
  'steer',
  'interrupt_and_send',
]));

export type PendingProviderAction = z.infer<typeof PendingProviderActionSchema>;
