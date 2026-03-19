import {
    claudeFocusedTranscriptShowsTeammateShutdownApproved,
    deriveClaudeTeamParticipants,
    deriveClaudeSpawnedTeammateFromTaskToolInput,
    deriveClaudeSpawnedTeammateFromTaskToolResult,
} from '@/sync/domains/session/participants/providers/claude/deriveClaudeTeamParticipants';
import { deriveClaudeTeamHintFromParticipantMessages, messagesContainClaudeTeamToolSignal } from '@/sync/domains/session/subagents/providers/claude/deriveClaudeTeamHints';
import { isGenericSubAgentToolName } from '@happier-dev/protocol/tools/v2';

import { findMatchingSessionSubagentForTool } from '../../../findMatchingSessionSubagentForTool';
import type { SessionSubagentAutoRecipientResolver } from '../../types';

function resolveDirectSpawnedTeammate(context: Parameters<SessionSubagentAutoRecipientResolver>[0]) {
    const spawned =
        deriveClaudeSpawnedTeammateFromTaskToolResult(context.tool.result)
        ?? deriveClaudeSpawnedTeammateFromTaskToolInput(context.tool.input);
    if (!spawned) return null;
    if (claudeFocusedTranscriptShowsTeammateShutdownApproved({
        teamId: spawned.teamId,
        memberId: spawned.memberId,
        ...(spawned.memberLabel ? { memberLabel: spawned.memberLabel } : {}),
        focusedMessages: context.focusedMessages,
    })) {
        return null;
    }

    return {
        kind: 'agent_team_member' as const,
        teamId: spawned.teamId,
        memberId: spawned.memberId,
        ...(spawned.memberLabel ? { memberLabel: spawned.memberLabel } : {}),
    };
}

export const resolveClaudeTeamMemberAutoRecipient: SessionSubagentAutoRecipientResolver = (context) => {
    if (!isGenericSubAgentToolName(context.tool.name)) return null;

    const directRecipient = resolveDirectSpawnedTeammate(context);
    if (directRecipient) return directRecipient;

    const matchingSubagent = findMatchingSessionSubagentForTool(context);
    if (
        matchingSubagent?.recipient?.kind === 'agent_team_member'
        && matchingSubagent.status === 'running'
        && matchingSubagent.capabilities.canSend
    ) {
        return matchingSubagent.recipient;
    }

    if (context.tool.name !== 'Agent') return null;

    const input = context.tool.input as Record<string, unknown> | null;
    const rawName = typeof input?.name === 'string' ? String(input.name).trim() : '';
    if (rawName.length === 0) return null;

    const inferredMatch = context.subagents.find((subagent) => {
        if (subagent.kind !== 'agent_team_member' || subagent.status !== 'running' || subagent.recipient?.kind !== 'agent_team_member') {
            return false;
        }
        if (subagent.recipient.memberId === rawName) return true;
        const memberPrefix = String(subagent.recipient.memberId.split('@')[0] ?? '').trim();
        if (memberPrefix && memberPrefix === rawName) return true;
        return subagent.display.title === rawName;
    });
    if (inferredMatch?.recipient?.kind === 'agent_team_member') {
        return inferredMatch.recipient;
    }

    const flavor = typeof (context.session as { metadata?: { flavor?: unknown } })?.metadata?.flavor === 'string'
        ? String((context.session as { metadata?: { flavor?: string } }).metadata?.flavor)
        : null;
    const hasClaudeToolSignal = messagesContainClaudeTeamToolSignal(context.messages);
    const snapshot = flavor === 'claude' || hasClaudeToolSignal
        ? deriveClaudeTeamParticipants({ messages: context.messages })
        : null;
    const hintedTeamId = snapshot?.teamId
        ?? (!hasClaudeToolSignal ? deriveClaudeTeamHintFromParticipantMessages(context.messages)?.teamId ?? null : null);
    if (!hintedTeamId) return null;

    return {
        kind: 'agent_team_member' as const,
        teamId: hintedTeamId,
        memberId: rawName.includes('@') ? rawName : `${rawName}@${hintedTeamId}`,
        memberLabel: rawName,
    };
};
