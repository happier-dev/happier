import { z } from 'zod';

export const PushNotificationTestRequestSchema = z.object({ tokenId: z.string().trim().min(1) }).strict();
export const PushNotificationTestResultSchema = z.object({
  status: z.enum(['accepted', 'not_registered', 'rejected', 'invalid_credentials']),
});
export type PushNotificationTestResult = z.infer<typeof PushNotificationTestResultSchema>;
