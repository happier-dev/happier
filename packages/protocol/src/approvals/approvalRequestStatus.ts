import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Released V1 lifecycle remains closed; it has no executing state. */
export const ApprovalRequestStatusSchema = lazyZodSchema(() => z.enum(['open', 'approved', 'rejected', 'executed', 'failed', 'canceled']));
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;

/** Current built-in and target Action approvals share the executable lifecycle. */
export const ApprovalRequestV2StatusSchema = lazyZodSchema(() => z.enum([
  'open', 'approved', 'executing', 'rejected', 'executed', 'failed', 'canceled', 'outcome_unknown',
]));

const IN_FLIGHT_V2_STATUSES: ReadonlySet<string> = new Set(['open', 'approved', 'executing']);

/** The request can still change: awaiting a decision or an effect settlement. Every other V2 status is terminal. */
export function isApprovalRequestV2InFlightStatus(status: unknown): boolean {
  return typeof status === 'string' && IN_FLIGHT_V2_STATUSES.has(status);
}

export function isApprovalRequestV2TerminalStatus(status: unknown): boolean {
  return typeof status === 'string'
    && ApprovalRequestV2StatusSchema.safeParse(status).success
    && !IN_FLIGHT_V2_STATUSES.has(status);
}
