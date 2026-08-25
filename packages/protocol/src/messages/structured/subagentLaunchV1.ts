import { z } from 'zod';

const AgentTeamCreateSubagentLaunchV1Schema = z.object({
  kind: z.literal('agent_team_create'),
  teamId: z.string().min(1),
  description: z.string().min(1).max(2000).optional(),
}).passthrough();

const AgentTeamMemberCreateSubagentLaunchV1Schema = z.object({
  kind: z.literal('agent_team_member_create'),
  teamId: z.string().min(1),
  memberLabel: z.string().min(1).max(200),
  instructions: z.string().min(1).max(20_000),
  runInBackground: z.boolean().optional(),
}).passthrough();

export const SubagentLaunchV1Schema = z.discriminatedUnion('kind', [
  AgentTeamCreateSubagentLaunchV1Schema,
  AgentTeamMemberCreateSubagentLaunchV1Schema,
]);
export type SubagentLaunchV1 = z.infer<typeof SubagentLaunchV1Schema>;

export function parseSubagentLaunchV1(input: unknown): SubagentLaunchV1 | null {
  const parsed = SubagentLaunchV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/**
 * Canonical private transport projection for one public semantic launch.
 * Callers can author only `SubagentLaunchV1`; the host owns the presentation
 * text and structured Message metadata written to the Session input.
 */
export function resolveSubagentLaunchStructuredSend(input: unknown): Readonly<{
  text: string;
  displayText: string;
  messageMeta: Readonly<{
    happier: Readonly<{ kind: 'subagent_launch.v1'; payload: SubagentLaunchV1 }>;
  }>;
}> {
  const payload = SubagentLaunchV1Schema.parse(input);
  const displayText = payload.kind === 'agent_team_create'
    ? `Create team ${payload.teamId}`
    : `Launch teammate ${payload.memberLabel} · ${payload.teamId}`;
  return Object.freeze({
    text: displayText,
    displayText,
    messageMeta: Object.freeze({
      happier: Object.freeze({ kind: 'subagent_launch.v1' as const, payload }),
    }),
  });
}
