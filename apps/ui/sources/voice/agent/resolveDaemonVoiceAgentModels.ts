import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
    describeEffectiveModelMode,
} from '@/sync/domains/models/describeEffectiveModelMode';
import {
    DEFAULT_AGENT_ID,
} from '@/agents/catalog/catalog';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

export function resolveDaemonVoiceAgentModelIds(params: {
    session: Session;
    agent: {
        chatModelSource?: 'session' | 'custom';
        chatModelId?: string;
        commitModelSource?: 'chat' | 'session' | 'custom';
        commitModelId?: string;
    };
}): { chatModelId: string; commitModelId: string } {
    const metadata = readSessionOwnerMetadataView(params.session);
    const agentId = resolveAgentIdFromSessionMetadata(metadata) ?? DEFAULT_AGENT_ID;

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
