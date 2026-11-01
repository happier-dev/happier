import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

const AgentTeamCreateSubagentLaunchV1Schema = lazySchema(() => z.object({
  kind: z.literal('agent_team_create'),
  teamId: z.string().min(1),
  description: z.string().min(1).max(2000).optional(),
}).passthrough());

const AgentTeamMemberCreateSubagentLaunchV1Schema = lazySchema(() => z.object({
  kind: z.literal('agent_team_member_create'),
  teamId: z.string().min(1),
  memberLabel: z.string().min(1).max(200),
  instructions: z.string().min(1).max(20_000),
  runInBackground: z.boolean().optional(),
}).passthrough());

export const SubagentLaunchV1Schema = lazySchema(() => z.discriminatedUnion('kind', [
  AgentTeamCreateSubagentLaunchV1Schema,
  AgentTeamMemberCreateSubagentLaunchV1Schema,
]));
export type SubagentLaunchV1 = z.infer<typeof SubagentLaunchV1Schema>;

export function parseSubagentLaunchV1(input: unknown): SubagentLaunchV1 | null {
  const parsed = SubagentLaunchV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
