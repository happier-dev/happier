import { parseParticipantMessageV1, type ParticipantMessageV1, type ParticipantRecipientV1 } from '@happier-dev/protocol';
import { readClaudeHappierEnvelope } from '@/backends/claude/utils/structuredMessages/readClaudeHappierEnvelope';

export type ClaudeParticipantRoutingMeta = Readonly<{
    recipient: Extract<ParticipantRecipientV1, { kind: 'agent_team_member' | 'agent_team_broadcast' }>;
    payload: ParticipantMessageV1;
}>;

export function parseParticipantMessageMeta(meta: unknown): ClaudeParticipantRoutingMeta | null {
    const env = readClaudeHappierEnvelope(meta);
    if (!env) return null;
    if (env.kind !== 'participant_message.v1') return null;

    const parsed = parseParticipantMessageV1(env.payload);
    if (!parsed) return null;
    const recipient = parsed.recipient;
    if (recipient.kind !== 'agent_team_member' && recipient.kind !== 'agent_team_broadcast') return null;
    return { recipient, payload: parsed };
}
