import { z } from '../../zodRuntimePolicy.js';

export const SessionLifecycleStateReasonSchema = z.literal('machine_access_withdrawn');
export type SessionLifecycleStateReason = z.infer<typeof SessionLifecycleStateReasonSchema>;
