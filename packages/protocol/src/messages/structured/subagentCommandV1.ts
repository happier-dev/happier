import { z } from '../../zodRuntimePolicy.js';

const AgentTeamDeleteSubagentCommandV1Schema = z.looseObject({
  kind: z.literal('agent_team_delete'),
  teamId: z.string().check(z.minLength(1)),
});

const AgentTeamMemberDeleteSubagentCommandV1Schema = z.looseObject({
  kind: z.literal('agent_team_member_delete'),
  teamId: z.string().check(z.minLength(1)),
  memberId: z.string().check(z.minLength(1)),
  memberLabel: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
});

export const SubagentCommandV1Schema = z.discriminatedUnion('kind', [
  AgentTeamDeleteSubagentCommandV1Schema,
  AgentTeamMemberDeleteSubagentCommandV1Schema,
]);
export type SubagentCommandV1 = z.infer<typeof SubagentCommandV1Schema>;

export function parseSubagentCommandV1(input: unknown): SubagentCommandV1 | null {
  const parsed = SubagentCommandV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** One command representation for Session Actions and composer presentation. */
export function resolveSubagentCommandStructuredSend(input: unknown): Readonly<{
  text: string;
  displayText: string;
  messageMeta: Readonly<{
    happier: Readonly<{ kind: 'subagent_command.v1'; payload: SubagentCommandV1 }>;
  }>;
}> {
  const payload = SubagentCommandV1Schema.parse(input);
  const displayText = payload.kind === 'agent_team_delete'
    ? `Delete team ${payload.teamId}`
    : `Shutdown teammate ${payload.memberLabel ?? payload.memberId} · ${payload.teamId}`;
  return Object.freeze({
    text: displayText,
    displayText,
    messageMeta: Object.freeze({
      happier: Object.freeze({ kind: 'subagent_command.v1' as const, payload }),
    }),
  });
}
