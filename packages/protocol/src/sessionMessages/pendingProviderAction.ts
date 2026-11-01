import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const PendingProviderActionSchema = lazySchema(() => z.enum([
  'send',
  'steer',
  'interrupt_and_send',
]));

export type PendingProviderAction = z.infer<typeof PendingProviderActionSchema>;
