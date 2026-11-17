import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { AgentExecutionTargetV1Schema } from '../agents/executionTargetV1.js';
import { ManagedSessionDefaultsV1Schema } from '../teams/managedSessionDefaultsV1.js';

/** Non-content project choices; shared Source and private For me rows use the same payload. */
export const ProjectSessionDefaultsV1Schema = lazyZodSchema(() => z.safeExtend(ManagedSessionDefaultsV1Schema, {
  defaultAgentTarget: z.optional(AgentExecutionTargetV1Schema),
}));
export type ProjectSessionDefaultsV1 = z.infer<typeof ProjectSessionDefaultsV1Schema>;
