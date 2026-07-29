import { z } from 'zod';

export const PendingProviderActionSchema = z.enum([
  'send',
  'steer',
  'interrupt_and_send',
]);

export type PendingProviderAction = z.infer<typeof PendingProviderActionSchema>;
