import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { ExecutionRunIdSchema, SessionIdSchema } from '../sessions/idsV1.js';
import { asProtocolZod } from './actions/internalProtocolZodAdapter.js';

/**
 * Host-stamped execution custody for plugin/runtime invocations. A detached
 * Execution Run is never projected through the Session arm.
 */
export const PluginExecutionScopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: asProtocolZod(SessionIdSchema) }).strict(),
  z.object({ kind: z.literal('execution_run'), executionRunId: ExecutionRunIdSchema }).strict(),
]));
export type PluginExecutionScopeV1 = z.infer<typeof PluginExecutionScopeV1Schema>;
