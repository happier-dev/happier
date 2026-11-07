import { z } from 'zod/mini';

import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { HostIdSchema } from '../../../runtime/agentSessionScalarsV1.js';
import { AgentSessionRuntimeRetryV1Schema } from '../../../runtime/agentSessionRuntimeRetryV1.js';

/** Content-free retry facts published by the host for the current turn. */
export const SessionTurnProgressV1Schema = lazyZodSchema(() => z.strictObject({
  ...AgentSessionRuntimeRetryV1Schema.shape,
  turnId: HostIdSchema,
  phase: z.literal('retrying'),
}));

export type SessionTurnProgressV1 = z.infer<typeof SessionTurnProgressV1Schema>;
