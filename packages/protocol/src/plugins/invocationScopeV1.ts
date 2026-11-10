import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { ExecutionRunIdSchema, SessionIdSchema } from '../sessions/idsV1.js';
import { asProtocolZod } from './actions/internalProtocolZodAdapter.js';

/**
 * Host-stamped execution custody for plugin/runtime invocations. A detached
 * Execution Run is never projected through the Session arm.
 */
export const PluginExecutionScopeV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), sessionId: asProtocolZod(SessionIdSchema) }),
  z.strictObject({ kind: z.literal('execution_run'), executionRunId: ExecutionRunIdSchema }),
]));
export type PluginExecutionScopeV1 = z.infer<typeof PluginExecutionScopeV1Schema>;
