import {
    deriveAgentTeamParticipants,
} from './participants';
import { createAgentTeamMemberAutoRecipientResolver } from './autoRecipient';
import {
    deriveAgentTeamHintFromParticipantMessages,
} from './hints';
import { deriveAgentTeamSidechainIds } from './sidechains';
import { deriveAgentTeamSubagents } from './subagents';
import { readAgentTeamIgnoredLifecycleEventType } from './lifecycleEvents';
import { hasAgentTeamFlavor, messagesContainAgentTeamToolSignal } from './descriptor';
import { resolveAgentTeamSessionFlavor } from './sessionFlavor';
import type {
    AgentTeamMessage,
    AgentTeamSessionParticipantTarget,
    AgentTeamSessionProviderBehavior,
    AgentTeamSessionProviderDescriptor,
} from './types';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

function isAgentTeamProviderSession(params: Readonly<{
    descriptor: AgentTeamSessionProviderDescriptor;
    flavor: string | null;
    messages: readonly AgentTeamMessage[];
}>): boolean {
    return hasAgentTeamFlavor(params.descriptor, params.flavor)
        || messagesContainAgentTeamToolSignal(params.descriptor, params.messages);
}

function deriveAgentTeamBroadcastTarget(params: Readonly<{
    descriptor: AgentTeamSessionProviderDescriptor;
    flavor: string | null;
    messages: readonly AgentTeamMessage[];
    currentTargets: readonly AgentTeamSessionParticipantTarget[];
}>): AgentTeamSessionParticipantTarget | null {
    const hasAgentTeamToolSignal = messagesContainAgentTeamToolSignal(params.descriptor, params.messages);
    if (!hasAgentTeamFlavor(params.descriptor, params.flavor) && !hasAgentTeamToolSignal) return null;
    if (params.currentTargets.some((target) => target.recipient.kind === 'agent_team_broadcast')) return null;

    const snapshot = deriveAgentTeamParticipants({ descriptor: params.descriptor, messages: params.messages });
    const hint = hasAgentTeamToolSignal ? null : deriveAgentTeamHintFromParticipantMessages(params.messages);
    const teamId = snapshot.teamId ?? hint?.teamId ?? null;
    if (!teamId) return null;

    return {
        key: `agent_team_broadcast:${teamId}`,
        displayLabel: teamId,
        recipient: { kind: 'agent_team_broadcast', teamId },
    };
}

export function createAgentTeamSessionProviderBehavior(
    descriptor: AgentTeamSessionProviderDescriptor,
): AgentTeamSessionProviderBehavior {
    return {
        participants: {
            deriveSnapshot: ({ flavor, messages }) => (
                isAgentTeamProviderSession({ descriptor, flavor, messages })
                    ? { [descriptor.snapshotKey]: deriveAgentTeamParticipants({ descriptor, messages }) }
                    : null
            ),
            deriveSidechainIds: ({ flavor, messages }) => (
                isAgentTeamProviderSession({ descriptor, flavor, messages })
                    ? deriveAgentTeamSidechainIds({ descriptor, messages })
                    : []
            ),
            deriveTargets: ({ session, messages, currentTargets }) => {
                const flavor = resolveAgentTeamSessionFlavor(readSessionOwnerMetadataView({
                    metadataLayoutVersion: session.metadataLayoutVersion,
                    metadata: session.metadata ?? null,
                    ownerMetadataView: session.ownerMetadataView,
                }));
                const target = deriveAgentTeamBroadcastTarget({
                    descriptor,
                    flavor,
                    messages,
                    currentTargets,
                });
                return target ? [target] : [];
            },
        },
        subagents: {
            deriveSubagents: ({ flavor, messages }) => deriveAgentTeamSubagents({ descriptor, flavor, messages }),
            shouldIgnoreActivityPreviewText: ({ subagent, text }) => {
                if (subagent.recipient?.kind !== 'agent_team_member') return false;
                return readAgentTeamIgnoredLifecycleEventType(descriptor, text) !== null;
            },
            resolveAutoRecipient: createAgentTeamMemberAutoRecipientResolver(descriptor),
        },
    };
}
