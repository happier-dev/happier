import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const SubagentGroupKindV1Schema = lazyZodSchema(() => z.enum(['team', 'pool', 'workflow', 'custom']));
export type SubagentGroupKindV1 = z.infer<typeof SubagentGroupKindV1Schema>;

export const SubagentGroupRefV1Schema = lazyZodSchema(() => z.looseObject({
  groupId: z.string().check(z.trim(), z.minLength(1)),
  groupKind: SubagentGroupKindV1Schema,
  providerGroupKind: z.optional(z.string().check(z.trim(), z.minLength(1))),
  groupLabel: z.optional(z.string()),
  memberId: z.string().check(z.trim(), z.minLength(1)),
  memberLabel: z.optional(z.string()),
  memberRole: z.optional(z.string()),
  supportsBroadcast: z.optional(z.boolean()),
}));
export type SubagentGroupRefV1 = z.infer<typeof SubagentGroupRefV1Schema>;
