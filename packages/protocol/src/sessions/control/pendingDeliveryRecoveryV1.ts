import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { SessionPendingWithdrawInputV1Schema } from './pendingWithdrawV1.js';

// Recovery keeps the same exact Pending identity as withdrawal. Main-conversation
// handled settlement has no Execution Run counterpart at the server owner.
export const SessionPendingMarkHandledInputV1Schema = lazyZodSchema(() =>
  z.omit(SessionPendingWithdrawInputV1Schema, { targetExecutionRunId: true }));
export const SessionPendingDeliveryRecoveryInputV1Schema = SessionPendingWithdrawInputV1Schema;
export const SessionPendingDeliveryRecoveryResultV1Schema = lazyZodSchema(() => z.strictObject({
  ok: z.literal(true),
}));
export const SessionPendingSendAsNewResultV1Schema = lazyZodSchema(() => z.strictObject({
  newLocalId: SessionPendingWithdrawInputV1Schema.shape.localId,
}));

export type SessionPendingMarkHandledInputV1 = z.infer<typeof SessionPendingMarkHandledInputV1Schema>;
export type SessionPendingDeliveryRecoveryInputV1 = z.infer<typeof SessionPendingDeliveryRecoveryInputV1Schema>;
