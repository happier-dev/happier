import { z } from '../zodRuntimePolicy.js';

import { lazyZodSchema } from '../lazyZodSchema.js';
import { SafeIntegerSchema } from './agentSessionScalarsV1.js';

/** Payload-free native retry evidence, not terminal failure or retry policy. */
export const AgentSessionRuntimeRetryV1Schema = lazyZodSchema(() => z.strictObject({
  attempt: SafeIntegerSchema.check(z.positive()),
  reason: z.enum(['connection_failed', 'rate_limited', 'server_error', 'unknown']),
}));
export type AgentSessionRuntimeRetryV1 = z.infer<typeof AgentSessionRuntimeRetryV1Schema>;
