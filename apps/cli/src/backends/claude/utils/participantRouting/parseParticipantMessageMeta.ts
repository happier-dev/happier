import { parseParticipantMessageV1, type ParticipantMessageV1, type ParticipantRecipientV1 } from '@happier-dev/protocol';

function readHappierEnvelope(meta: unknown): { kind: string; payload: unknown } | null {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const record = meta as Record<string, unknown>;
    const happier = record.happier;
    if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return null;
    const env = happier as Record<string, unknown>;
    if (typeof env.kind !== 'string') return null;
    return { kind: env.kind, payload: env.payload };
}

export type ClaudeParticipantRoutingMeta = Readonly<{
    recipient: Extract<ParticipantRecipientV1, { kind: 'agent_team_member' | 'agent_team_broadcast' }>;
    payload: ParticipantMessageV1;
}>;

export function parseParticipantMessageMeta(meta: unknown): ClaudeParticipantRoutingMeta | null {
    const env = readHappierEnvelope(meta);
    if (!env) return null;
    if (env.kind !== 'participant_message.v1') return null;

    const parsed = parseParticipantMessageV1(env.payload);
    if (!parsed) return null;
    const recipient = parsed.recipient;
    if (recipient.kind !== 'agent_team_member' && recipient.kind !== 'agent_team_broadcast') return null;
    return { recipient, payload: parsed };
}
