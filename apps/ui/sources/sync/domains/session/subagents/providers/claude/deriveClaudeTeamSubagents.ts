import type { Message, ToolCallMessage } from '@/sync/domains/messages/messageTypes';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';

import {
    deriveClaudeSpawnedTeammateFromTaskToolInput,
    deriveClaudeSpawnedTeammateFromTaskToolResult,
    deriveClaudeTeamParticipants,
} from '@/sync/domains/session/participants/providers/claude/deriveClaudeTeamParticipants';

import type { SessionSubagent } from '../../types';
import {
    deriveClaudeTeamHintFromParticipantMessages,
    deriveClaudeTeamHintFromSubagentMessages,
    messagesContainClaudeTeamToolSignal,
} from './deriveClaudeTeamHints';

type HistoricalClaudeMember = {
    teamId: string;
    memberId: string;
    memberLabel?: string;
    memberColor?: string;
    toolMessageRouteId?: string;
    toolId?: string;
    sidechainId?: string;
    updatedAtMs?: number;
    routePriority?: number;
};

type ActiveClaudeMember = Readonly<{
    memberId: string;
    memberLabel?: string;
    memberColor?: string;
}>;

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function coerceSpawnedTeammate(record: unknown): {
    teamId: string;
    memberId: string;
    memberLabel?: string;
    memberColor?: string;
} | null {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    const value = record as Record<string, unknown>;
    const teamId = readNonEmptyString(value.team_name) ?? readNonEmptyString(value.teamId);
    if (!teamId) return null;

    const memberId =
        readNonEmptyString(value.agent_id)
        ?? readNonEmptyString(value.teammate_id)
        ?? readNonEmptyString(value.agentId);
    if (memberId) {
        return {
            teamId,
            memberId,
            ...(readNonEmptyString(value.name) ? { memberLabel: readNonEmptyString(value.name)! } : {}),
            ...(readNonEmptyString(value.color) ? { memberColor: readNonEmptyString(value.color)! } : {}),
        };
    }

    const memberLabel =
        readNonEmptyString(value.name)
        ?? readNonEmptyString(value.recipient)
        ?? readNonEmptyString(value.target);
    if (!memberLabel) return null;
    return {
        teamId,
        memberId: memberLabel.includes('@') ? memberLabel : `${memberLabel}@${teamId}`,
        memberLabel,
        ...(readNonEmptyString(value.color) ? { memberColor: readNonEmptyString(value.color)! } : {}),
    };
}

function deriveHistoricalClaudeMembers(messages: readonly Message[]): Map<string, HistoricalClaudeMember> {
    const historicalMembers = new Map<string, HistoricalClaudeMember>();

    for (const message of messages) {
        if (!message || message.kind !== 'tool-call') continue;
        const toolMessage = message as ToolCallMessage;
        const toolName = toolMessage.tool?.name;
        if (!isGenericSubAgentToolName(toolName ?? '')) continue;

        const spawned =
            coerceSpawnedTeammate((toolMessage.tool.result as any)?.tool_use_result)
            ?? coerceSpawnedTeammate(toolMessage.tool.result)
            ?? coerceSpawnedTeammate(toolMessage.tool.input);
        if (!spawned) continue;

        const memberKey = `${spawned.teamId}:${spawned.memberId}`;
        const existing = historicalMembers.get(memberKey);
        const toolId = readNonEmptyString(toolMessage.tool?.id);
        const hasExplicitSpawnSignal =
            toolName !== 'Agent'
            && (
                deriveClaudeSpawnedTeammateFromTaskToolResult(toolMessage.tool.result) !== null
                || deriveClaudeSpawnedTeammateFromTaskToolInput(toolMessage.tool.input) !== null
            );
        const routePriority = hasExplicitSpawnSignal ? 3 : toolName === 'Agent' ? 2 : 1;
        const shouldReplaceTranscriptRoute = !existing || routePriority > (existing.routePriority ?? 0);
        const updatedAtMs = typeof toolMessage.createdAt === 'number' ? toolMessage.createdAt : undefined;
        historicalMembers.set(memberKey, {
            teamId: spawned.teamId,
            memberId: spawned.memberId,
            memberLabel: spawned.memberLabel ?? existing?.memberLabel,
            memberColor: spawned.memberColor ?? existing?.memberColor,
            toolMessageRouteId: shouldReplaceTranscriptRoute ? toolMessage.id : existing?.toolMessageRouteId,
            toolId: shouldReplaceTranscriptRoute ? (toolId ?? existing?.toolId) : existing?.toolId,
            sidechainId: shouldReplaceTranscriptRoute ? (toolId ?? existing?.sidechainId) : existing?.sidechainId,
            updatedAtMs: updatedAtMs ?? existing?.updatedAtMs,
            routePriority: Math.max(routePriority, existing?.routePriority ?? 0),
        });
    }

    return historicalMembers;
}

export function deriveClaudeTeamSubagents(params: Readonly<{
    flavor: string | null;
    messages: readonly Message[];
}>): readonly SessionSubagent[] {
    const hasToolSignal = messagesContainClaudeTeamToolSignal(params.messages);
    if (params.flavor !== 'claude' && !hasToolSignal) return [];

    const snapshot = deriveClaudeTeamParticipants({ messages: params.messages });
    const participantHint = !hasToolSignal ? deriveClaudeTeamHintFromParticipantMessages(params.messages) : null;
    const subagentHint = deriveClaudeTeamHintFromSubagentMessages(params.messages);
    const activeTeamId = snapshot.teamId ?? subagentHint?.teamId ?? participantHint?.teamId ?? null;
    const activeMembersByKey = new Map<string, ActiveClaudeMember>();
    for (const member of snapshot.members) {
        activeMembersByKey.set(member.memberId, member);
    }
    if (subagentHint && (!activeTeamId || subagentHint.teamId === activeTeamId)) {
        for (const member of subagentHint.members) {
            if (activeMembersByKey.has(member.memberId)) continue;
            activeMembersByKey.set(member.memberId, {
                memberId: member.memberId,
                ...(member.memberLabel ? { memberLabel: member.memberLabel } : {}),
            });
        }
    }
    if (participantHint && (!activeTeamId || participantHint.teamId === activeTeamId)) {
        for (const member of participantHint.members) {
            if (activeMembersByKey.has(member.memberId)) continue;
            activeMembersByKey.set(member.memberId, {
                memberId: member.memberId,
                ...(member.memberLabel ? { memberLabel: member.memberLabel } : {}),
            });
        }
    }
    const activeMembers = Array.from(activeMembersByKey.values());
    const activeMembersByIdentity = new Map<string, ActiveClaudeMember>(
        activeMembers.map((member) => [`${activeTeamId ?? ''}:${member.memberId}`, member]),
    );
    const historicalMembers = deriveHistoricalClaudeMembers(
        params.messages.map((message) => {
            if (!message || message.kind !== 'tool-call') return message;
            const toolMessage = message as ToolCallMessage;
            if (toolMessage.tool?.name !== 'Agent' || activeTeamId == null) return message;
            const inputRecord =
                toolMessage.tool.input && typeof toolMessage.tool.input === 'object' && !Array.isArray(toolMessage.tool.input)
                    ? (toolMessage.tool.input as Record<string, unknown>)
                    : null;
            if (!inputRecord) return message;
            if (readNonEmptyString(inputRecord.team_name) || readNonEmptyString(inputRecord.teamId)) return message;
            const rawName = readNonEmptyString(inputRecord.name);
            if (!rawName) return message;
            return {
                ...toolMessage,
                tool: {
                    ...toolMessage.tool,
                    input: { ...inputRecord, team_name: activeTeamId },
                },
            };
        }),
    );

    for (const activeMember of activeMembers) {
        if (!activeTeamId) continue;
        const key = `${activeTeamId}:${activeMember.memberId}`;
        if (historicalMembers.has(key)) continue;
        historicalMembers.set(key, {
            teamId: activeTeamId,
            memberId: activeMember.memberId,
            memberLabel: activeMember.memberLabel,
            memberColor: activeMember.memberColor,
        });
    }

    return Array.from(historicalMembers.values()).map((member) => {
        const activeKey = `${member.teamId}:${member.memberId}`;
        const active = activeMembersByIdentity.get(activeKey);
        const displayLabel = active?.memberLabel ?? member.memberLabel ?? member.memberId;
        const accentName = active?.memberColor ?? member.memberColor;
        const status = active ? 'running' : 'terminated';

        return {
            id: `agent_team_member:${member.teamId}:${member.memberId}`,
            kind: 'agent_team_member',
            status,
            display: {
                title: displayLabel,
                providerLabel: 'Claude',
                ...(accentName ? { accentName } : {}),
                groupKey: member.teamId,
                groupLabel: member.teamId,
            },
            transcript: {
                ...(member.sidechainId ? { sidechainId: member.sidechainId } : {}),
                ...(member.toolMessageRouteId ? { toolMessageRouteId: member.toolMessageRouteId } : {}),
                ...(member.toolId ? { toolId: member.toolId } : {}),
            },
            recipient: status === 'running'
                ? {
                    kind: 'agent_team_member',
                    teamId: member.teamId,
                    memberId: member.memberId,
                    ...(active?.memberLabel ?? member.memberLabel ? { memberLabel: active?.memberLabel ?? member.memberLabel } : {}),
                }
                : null,
            capabilities: {
                canOpen: Boolean(member.sidechainId),
                canSend: status === 'running',
                canStop: false,
                canLaunchChild: false,
                canDelete: status === 'running',
                canOpenAdvancedRun: false,
            },
            timestamps: {
                ...(member.updatedAtMs ? { startedAtMs: member.updatedAtMs, updatedAtMs: member.updatedAtMs } : {}),
            },
        } satisfies SessionSubagent;
    });
}
