import {
    agentTeamFocusedTranscriptShowsTeammateShutdownApproved,
    deriveAgentTeamParticipants,
    deriveAgentTeamSpawnedTeammateFromTaskToolInput,
    deriveAgentTeamSpawnedTeammateFromTaskToolResult,
} from './participants';
import { deriveAgentTeamHintFromParticipantMessages } from './hints';
import {
    hasAgentTeamFlavor,
    isAgentTeamActiveTeamFallbackSubagentSpawnToolName,
    isAgentTeamSubagentSpawnToolName,
    messagesContainAgentTeamToolSignal,
} from './descriptor';
import { resolveAgentTeamSessionFlavor } from './sessionFlavor';

import type {
    AgentTeamReadableSessionSubagent,
    AgentTeamSessionProviderDescriptor,
    AgentTeamSessionSubagentAutoRecipientContext,
} from './types';

function findMatchingAgentTeamSessionSubagentForTool(context: AgentTeamSessionSubagentAutoRecipientContext): AgentTeamReadableSessionSubagent | null {
    const toolId = typeof context.tool.id === 'string' ? context.tool.id.trim() : '';
    if (!toolId) return null;

    return context.subagents.find((subagent) => (
        subagent.transcript.toolId === toolId
        || subagent.transcript.sidechainId === toolId
    )) ?? null;
}

function resolveDirectSpawnedTeammate(
    descriptor: AgentTeamSessionProviderDescriptor,
    context: AgentTeamSessionSubagentAutoRecipientContext,
) {
    const spawned =
        deriveAgentTeamSpawnedTeammateFromTaskToolResult(context.tool.result)
        ?? deriveAgentTeamSpawnedTeammateFromTaskToolInput(context.tool.input);
    if (!spawned) return null;
    if (agentTeamFocusedTranscriptShowsTeammateShutdownApproved({
        descriptor,
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

export function createAgentTeamMemberAutoRecipientResolver(descriptor: AgentTeamSessionProviderDescriptor) {
    return (context: AgentTeamSessionSubagentAutoRecipientContext) => {
        if (!isAgentTeamSubagentSpawnToolName(descriptor, context.tool.name)) return null;

        const directRecipient = resolveDirectSpawnedTeammate(descriptor, context);
        if (directRecipient) return directRecipient;

        const matchingSubagent = findMatchingAgentTeamSessionSubagentForTool(context);
        if (
            matchingSubagent?.recipient?.kind === 'agent_team_member'
            && matchingSubagent.status === 'running'
            && matchingSubagent.capabilities.canSend
        ) {
            return matchingSubagent.recipient;
        }

        if (!isAgentTeamActiveTeamFallbackSubagentSpawnToolName(descriptor, context.tool.name)) return null;

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

        const flavor = resolveAgentTeamSessionFlavor((context.session as { metadata?: unknown })?.metadata);
        const hasAgentTeamToolSignal = messagesContainAgentTeamToolSignal(descriptor, context.messages);
        const snapshot = hasAgentTeamFlavor(descriptor, flavor) || hasAgentTeamToolSignal
            ? deriveAgentTeamParticipants({ descriptor, messages: context.messages })
            : null;
        const hintedTeamId = snapshot?.teamId
            ?? (!hasAgentTeamToolSignal ? deriveAgentTeamHintFromParticipantMessages(context.messages)?.teamId ?? null : null);
        if (!hintedTeamId) return null;

        return {
            kind: 'agent_team_member' as const,
            teamId: hintedTeamId,
            memberId: rawName.includes('@') ? rawName : `${rawName}@${hintedTeamId}`,
            memberLabel: rawName,
        };
    };
}
