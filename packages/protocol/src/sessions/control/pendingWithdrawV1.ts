import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PendingMessageWithdrawOutcomeV1Schema } from '../pending/pendingActivationAuthorizationV1.js';

const id = () => z.string().trim().min(1);
export const SessionPendingWithdrawInputV1Schema = lazyZodSchema(() => z.object({
  sessionId: id(), localId: id(), serverId: id().optional(), targetExecutionRunId: id().optional(),
}).strict());
export const SessionPendingWithdrawResultV1Schema = lazyZodSchema(() => z.object({
  outcome: PendingMessageWithdrawOutcomeV1Schema,
}).strict());
export type SessionPendingWithdrawInputV1 = z.infer<typeof SessionPendingWithdrawInputV1Schema>;
