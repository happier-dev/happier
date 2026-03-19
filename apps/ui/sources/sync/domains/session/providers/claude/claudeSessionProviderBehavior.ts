import { resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import type { Message } from '@/sync/domains/messages/messageTypes';
import type { SessionParticipantTarget } from '@/sync/domains/session/participants/participantTargets';
import {
    deriveClaudeTeamParticipants,
} from '@/sync/domains/session/participants/providers/claude/deriveClaudeTeamParticipants';
import { deriveClaudeTeamSidechainIds } from '@/sync/domains/session/participants/providers/claude/deriveClaudeTeamSidechainIds';
import { resolveClaudeTeamMemberAutoRecipient } from '@/sync/domains/session/subagents/autoRecipient/providers/claude/resolveClaudeTeamMemberAutoRecipient';
import {
    deriveClaudeTeamHintFromParticipantMessages,
    messagesContainClaudeTeamToolSignal,
} from '@/sync/domains/session/subagents/providers/claude/deriveClaudeTeamHints';
import { deriveClaudeTeamSubagents } from '@/sync/domains/session/subagents/providers/claude/deriveClaudeTeamSubagents';
import { readClaudeIgnoredLifecycleEventType } from '@/sync/domains/session/subagents/providers/claude/readClaudeIgnoredLifecycleEventType';
import type { SessionProviderBehavior } from '@/sync/domains/session/providers/sessionProviderBehaviorTypes';

function isClaudeProviderSession(params: Readonly<{
    flavor: string | null;
    messages: readonly Message[];
}>): boolean {
    return resolveAgentIdFromFlavor(params.flavor) === 'claude'
        || messagesContainClaudeTeamToolSignal(params.messages);
}

function deriveClaudeBroadcastTarget(params: Readonly<{
    flavor: string | null;
    messages: readonly Message[];
    currentTargets: readonly SessionParticipantTarget[];
}>): SessionParticipantTarget | null {
    const hasClaudeToolSignal = messagesContainClaudeTeamToolSignal(params.messages);
    if (resolveAgentIdFromFlavor(params.flavor) !== 'claude' && !hasClaudeToolSignal) return null;
    if (params.currentTargets.some((target) => target.recipient.kind === 'agent_team_broadcast')) return null;

    const snapshot = deriveClaudeTeamParticipants({ messages: params.messages });
    const hint = hasClaudeToolSignal ? null : deriveClaudeTeamHintFromParticipantMessages(params.messages);
    const teamId = snapshot.teamId ?? hint?.teamId ?? null;
    if (!teamId) return null;

    return {
        key: `agent_team_broadcast:${teamId}`,
        displayLabel: teamId,
        recipient: { kind: 'agent_team_broadcast', teamId },
    };
}

export const CLAUDE_SESSION_PROVIDER_BEHAVIOR: SessionProviderBehavior = {
    participants: {
        deriveSnapshot: ({ flavor, messages }) => (
            isClaudeProviderSession({ flavor, messages })
                ? { claudeTeam: deriveClaudeTeamParticipants({ messages }) }
                : null
        ),
        deriveSidechainIds: ({ flavor, messages }) => (
            isClaudeProviderSession({ flavor, messages })
                ? deriveClaudeTeamSidechainIds({ messages })
                : []
        ),
        deriveTargets: ({ session, messages, currentTargets }) => {
            const flavor = typeof session.metadata?.flavor === 'string' ? session.metadata.flavor : null;
            const target = deriveClaudeBroadcastTarget({
                flavor,
                messages,
                currentTargets,
            });
            return target ? [target] : [];
        },
    },
    subagents: {
        deriveSubagents: ({ flavor, messages }) => deriveClaudeTeamSubagents({ flavor, messages }),
        shouldIgnoreActivityPreviewText: ({ subagent, text }) => {
            if (subagent.recipient?.kind !== 'agent_team_member') return false;
            return readClaudeIgnoredLifecycleEventType(text) !== null;
        },
        resolveAutoRecipient: resolveClaudeTeamMemberAutoRecipient,
    },
};
