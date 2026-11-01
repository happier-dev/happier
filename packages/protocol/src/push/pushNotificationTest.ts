import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const PushNotificationTestRequestSchema = lazySchema(() => z.object({ tokenId: z.string().trim().min(1) }).strict());
export const PushNotificationTestResultSchema = lazySchema(() => z.object({
  status: z.enum(['accepted', 'not_registered', 'rejected', 'invalid_credentials']),
}));
export type PushNotificationTestResult = z.infer<typeof PushNotificationTestResultSchema>;
