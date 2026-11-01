import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

const AgentTeamDeleteSubagentCommandV1Schema = lazySchema(() => z.object({
  kind: z.literal('agent_team_delete'),
  teamId: z.string().min(1),
}).passthrough());

const AgentTeamMemberDeleteSubagentCommandV1Schema = lazySchema(() => z.object({
  kind: z.literal('agent_team_member_delete'),
  teamId: z.string().min(1),
  memberId: z.string().min(1),
  memberLabel: z.string().min(1).max(200).optional(),
}).passthrough());

export const SubagentCommandV1Schema = lazySchema(() => z.discriminatedUnion('kind', [
  AgentTeamDeleteSubagentCommandV1Schema,
  AgentTeamMemberDeleteSubagentCommandV1Schema,
]));
export type SubagentCommandV1 = z.infer<typeof SubagentCommandV1Schema>;

export function parseSubagentCommandV1(input: unknown): SubagentCommandV1 | null {
  const parsed = SubagentCommandV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
