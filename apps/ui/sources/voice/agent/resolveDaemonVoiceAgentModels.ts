import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
    describeEffectiveModelMode,
} from '@/sync/domains/models/describeEffectiveModelMode';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export type DaemonVoiceAgentModelIds = Readonly<{
    chatModelId: string;
    commitModelId: string;
}>;

/**
 * Model ids for a daemon voice run, or `null` when the target Session's Agent
 * identity is unreadable.
 *
 * `null` is the typed unavailable: with no Agent there is no Agent-owned model
 * fact to report. Substituting the default Agent would describe another Agent's
 * models as this Session's, and an empty Agent id is not a lighter version of
 * that lie — it reaches the backend-target reader and throws. Callers own the
 * unavailable case explicitly.
 */
export function resolveDaemonVoiceAgentModelIds(params: {
    session: Session;
    agent: {
        chatModelSource?: 'session' | 'custom';
        chatModelId?: string;
        commitModelSource?: 'chat' | 'session' | 'custom';
        commitModelId?: string;
    };
}): DaemonVoiceAgentModelIds | null {
    const metadata = readSessionOwnerMetadataView(params.session);
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    if (!agentId) return null;

    const sessionSelected = (params.session.modelMode ?? 'default') as any;

    const chatSelected =
        params.agent.chatModelSource === 'session'
            ? sessionSelected
            : (params.agent.chatModelId ?? 'default');
    const chatModelId = describeEffectiveModelMode({
        agentType: agentId,
        selectedModelId: chatSelected,
        metadata,
    }).effectiveModelId;

    const commitSelected = (() => {
        switch (params.agent.commitModelSource) {
            case 'session':
                return sessionSelected;
            case 'custom':
                return params.agent.commitModelId ?? 'default';
            case 'chat':
            default:
                return chatModelId;
        }
    })();

    const commitModelId = describeEffectiveModelMode({
        agentType: agentId,
        selectedModelId: commitSelected,
        metadata,
    }).effectiveModelId;

    return { chatModelId, commitModelId };
}
