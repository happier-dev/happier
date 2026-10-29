import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Released V1 lifecycle remains closed; it has no executing state. */
export const ApprovalRequestStatusSchema = lazyZodSchema(() => z.enum(['open', 'approved', 'rejected', 'executed', 'failed', 'canceled']));
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;

/** Current built-in and target Action approvals share the executable lifecycle. */
export const ApprovalRequestV2StatusSchema = lazyZodSchema(() => z.enum([
  'open', 'approved', 'executing', 'rejected', 'executed', 'failed', 'canceled', 'outcome_unknown',
]));
