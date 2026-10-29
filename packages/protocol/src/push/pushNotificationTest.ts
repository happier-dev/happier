import { z } from 'zod/mini';

/** One explicit plumbing test, never an assertion of phone receipt or display. */
export const PushNotificationTestResultSchema = z.strictObject({
  status: z.enum(['accepted', 'not_registered', 'rejected', 'invalid_credentials', 'unsupported']),
});
export type PushNotificationTestResult = z.infer<typeof PushNotificationTestResultSchema>;
