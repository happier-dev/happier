import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PendingMessageWithdrawOutcomeV1Schema } from '../pending/pendingActivationAuthorizationV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));
export const SessionPendingWithdrawInputV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: id(), localId: id(), serverId: z.optional(id()), targetExecutionRunId: z.optional(id()),
}));
export const SessionPendingWithdrawResultV1Schema = lazyZodSchema(() => z.strictObject({
  outcome: PendingMessageWithdrawOutcomeV1Schema,
}));
export type SessionPendingWithdrawInputV1 = z.infer<typeof SessionPendingWithdrawInputV1Schema>;
