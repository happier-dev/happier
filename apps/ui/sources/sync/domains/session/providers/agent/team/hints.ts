import type { AgentTeamMessage } from './types';

export type AgentTeamParticipantMessageTeamHint = Readonly<{
    teamId: string;
    members: ReadonlyArray<Readonly<{ memberId: string; memberLabel?: string }>>;
}>;

type AgentTeamParticipantRecipient =
    | Readonly<{ kind: 'agent_team_member'; teamId: string; memberId: string; memberLabel?: string }>
    | Readonly<{ kind: 'agent_team_broadcast'; teamId: string }>;

type AgentTeamParticipantMessagePayload = Readonly<{
    recipient: AgentTeamParticipantRecipient;
}>;

type AgentTeamSubagentLaunchPayload =
    | Readonly<{ kind: 'agent_team_create'; teamId: string }>
    | Readonly<{ kind: 'agent_team_member_create'; teamId: string; memberLabel: string }>;

type AgentTeamSubagentCommandPayload =
    | Readonly<{ kind: 'agent_team_delete'; teamId: string }>
    | Readonly<{ kind: 'agent_team_member_delete'; teamId: string; memberId: string; memberLabel?: string }>;

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function parseParticipantMessagePayload(payload: unknown): AgentTeamParticipantMessagePayload | null {
    const record = asRecord(payload);
    const recipient = asRecord(record?.recipient);
    if (!recipient) return null;

    const kind = readNonEmptyString(recipient.kind);
    const teamId = readNonEmptyString(recipient.teamId);
    if (!kind || !teamId) return null;

    if (kind === 'agent_team_broadcast') {
        return { recipient: { kind, teamId } };
    }

    if (kind !== 'agent_team_member') return null;
    const memberId = readNonEmptyString(recipient.memberId);
    if (!memberId) return null;

    const memberLabel = readNonEmptyString(recipient.memberLabel) ?? undefined;
    return {
        recipient: {
            kind,
            teamId,
            memberId,
            ...(memberLabel ? { memberLabel } : {}),
        },
    };
}

function parseSubagentLaunchPayload(payload: unknown): AgentTeamSubagentLaunchPayload | null {
    const record = asRecord(payload);
    const kind = readNonEmptyString(record?.kind);
    const teamId = readNonEmptyString(record?.teamId);
    if (!kind || !teamId) return null;

    if (kind === 'agent_team_create') {
        return { kind, teamId };
    }

    if (kind !== 'agent_team_member_create') return null;
    const memberLabel = readNonEmptyString(record?.memberLabel);
    if (!memberLabel) return null;

    return { kind, teamId, memberLabel };
}

function parseSubagentCommandPayload(payload: unknown): AgentTeamSubagentCommandPayload | null {
    const record = asRecord(payload);
    const kind = readNonEmptyString(record?.kind);
    const teamId = readNonEmptyString(record?.teamId);
    if (!kind || !teamId) return null;

    if (kind === 'agent_team_delete') {
        return { kind, teamId };
    }

    if (kind !== 'agent_team_member_delete') return null;
    const memberId = readNonEmptyString(record?.memberId);
    if (!memberId) return null;

    const memberLabel = readNonEmptyString(record?.memberLabel) ?? undefined;
    return {
        kind,
        teamId,
        memberId,
        ...(memberLabel ? { memberLabel } : {}),
    };
}

function readHappierMetaEnvelope(meta: unknown): Readonly<{ kind: string; payload: unknown }> | null {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
    const record = meta as Record<string, unknown>;
    const happier = record.happier;
    if (!happier || typeof happier !== 'object' || Array.isArray(happier)) return null;
    const envelope = happier as Record<string, unknown>;
    const kind = typeof envelope.kind === 'string' ? envelope.kind : '';
    if (!kind) return null;
    return { kind, payload: envelope.payload };
}

function normalizeAgentTeamMemberId(teamId: string, memberId: string | null, memberLabel?: string): string | null {
    const normalizedMemberId = typeof memberId === 'string' ? memberId.trim() : '';
    if (normalizedMemberId.length > 0) return normalizedMemberId.includes('@') ? normalizedMemberId : `${normalizedMemberId}@${teamId}`;
    const normalizedLabel = typeof memberLabel === 'string' ? memberLabel.trim() : '';
    if (normalizedLabel.length === 0) return null;
    return normalizedLabel.includes('@') ? normalizedLabel : `${normalizedLabel}@${teamId}`;
}

export function deriveAgentTeamHintFromParticipantMessages(
    messages: readonly AgentTeamMessage[],
): AgentTeamParticipantMessageTeamHint | null {
    const membersById = new Map<string, { memberId: string; memberLabel?: string }>();
    let teamId: string | null = null;

    for (const message of messages) {
        if (!message || message.kind !== 'user-text') continue;
        const envelope = readHappierMetaEnvelope(message.meta);
        if (!envelope) continue;

        if (envelope.kind !== 'participant_message.v1') continue;

        const parsed = parseParticipantMessagePayload(envelope.payload);
        if (!parsed) continue;
        const recipient = parsed.recipient;
        if (recipient.kind === 'agent_team_broadcast') {
            teamId = recipient.teamId;
            continue;
        }
        if (recipient.kind === 'agent_team_member') {
            teamId = recipient.teamId;
            const memberId = normalizeAgentTeamMemberId(
                recipient.teamId,
                String(recipient.memberId).trim(),
                typeof recipient.memberLabel === 'string' ? recipient.memberLabel : undefined,
            );
            if (!memberId || membersById.has(memberId)) continue;
            const memberLabel =
                typeof recipient.memberLabel === 'string' && recipient.memberLabel.trim().length > 0
                    ? recipient.memberLabel.trim()
                    : undefined;
            membersById.set(memberId, { memberId, ...(memberLabel ? { memberLabel } : {}) });
        }
    }

    if (!teamId) return null;
    return { teamId, members: Array.from(membersById.values()) };
}

export function deriveAgentTeamHintFromSubagentMessages(
    messages: readonly AgentTeamMessage[],
): AgentTeamParticipantMessageTeamHint | null {
    const membersById = new Map<string, { memberId: string; memberLabel?: string }>();
    let teamId: string | null = null;

    for (const message of messages) {
        if (!message || message.kind !== 'user-text') continue;
        const envelope = readHappierMetaEnvelope(message.meta);
        if (!envelope) continue;

        if (envelope.kind === 'subagent_launch.v1') {
            const parsed = parseSubagentLaunchPayload(envelope.payload);
            if (!parsed) continue;
            teamId = parsed.teamId;
            if (parsed.kind !== 'agent_team_member_create') continue;
            const memberId = normalizeAgentTeamMemberId(parsed.teamId, parsed.memberLabel, parsed.memberLabel);
            if (!memberId || membersById.has(memberId)) continue;
            membersById.set(memberId, { memberId, memberLabel: parsed.memberLabel.trim() });
            continue;
        }

        if (envelope.kind === 'subagent_command.v1') {
            const parsed = parseSubagentCommandPayload(envelope.payload);
            if (!parsed) continue;
            if (parsed.kind === 'agent_team_delete') {
                if (teamId === parsed.teamId) {
                    teamId = null;
                    membersById.clear();
                }
                continue;
            }
            if (teamId !== parsed.teamId) continue;
            const normalizedMemberId = normalizeAgentTeamMemberId(parsed.teamId, parsed.memberId, parsed.memberLabel);
            if (normalizedMemberId) membersById.delete(normalizedMemberId);
        }
    }

    if (!teamId) return null;
    return { teamId, members: Array.from(membersById.values()) };
}
