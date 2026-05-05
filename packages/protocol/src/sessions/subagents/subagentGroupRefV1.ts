import { z } from 'zod';

export const SubagentGroupKindV1Schema = z.enum(['team', 'pool', 'workflow', 'custom']);
export type SubagentGroupKindV1 = z.infer<typeof SubagentGroupKindV1Schema>;

export const SubagentGroupRefV1Schema = z.object({
  groupId: z.string().trim().min(1),
  groupKind: SubagentGroupKindV1Schema,
  providerGroupKind: z.string().trim().min(1).optional(),
  groupLabel: z.string().optional(),
  memberId: z.string().trim().min(1),
  memberLabel: z.string().optional(),
  memberRole: z.string().optional(),
  supportsBroadcast: z.boolean().optional(),
}).passthrough();
export type SubagentGroupRefV1 = z.infer<typeof SubagentGroupRefV1Schema>;
