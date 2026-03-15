import type { Message } from '@/sync/domains/messages/messageTypes';

import { deriveClaudeTeamParticipants, type ClaudeTeamParticipantSnapshot } from './claude/deriveClaudeTeamParticipants';

export type ProviderParticipantSnapshot = Readonly<{
    claudeTeam?: ClaudeTeamParticipantSnapshot;
}>;

function looksLikeClaudeAgentTeamTranscript(messages: readonly Message[]): boolean {
    for (const m of messages) {
        if (!m || m.kind !== 'tool-call') continue;
        const toolName = (m as any)?.tool?.name;
        if (toolName === 'AgentTeamCreate' || toolName === 'TeamCreate') return true;
        if (toolName === 'AgentTeamSendMessage') return true;
    }
    return false;
}

export function deriveProviderParticipantSnapshot(params: Readonly<{
    flavor: string | null;
    messages: readonly Message[];
}>): ProviderParticipantSnapshot {
    if (params.flavor === 'claude' || looksLikeClaudeAgentTeamTranscript(params.messages)) {
        return { claudeTeam: deriveClaudeTeamParticipants({ messages: params.messages }) };
    }
    return {};
}
