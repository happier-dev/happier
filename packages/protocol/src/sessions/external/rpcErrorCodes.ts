import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

/**
 * Outward External Sessions failure classes. Each one names a different next
 * step for a person: `agent_unavailable` means the Agent cannot serve this
 * machine at all (missing, unsupported, unauthenticated), `agent_timeout` means
 * it did not answer within the operation deadline and a retry may succeed, and
 * `agent_error` means it answered with a fault (for example session data it
 * could not read, or a process that failed to start).
 */
export const ExternalSessionsRpcErrorCodeSchema = lazyZodSchema(() => z.enum([
  'invalid_request',
  'machine_offline',
  'agent_unavailable',
  'agent_timeout',
  'agent_error',
  'internal_error',
]));
export type ExternalSessionsRpcErrorCode = z.infer<typeof ExternalSessionsRpcErrorCodeSchema>;
