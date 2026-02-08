import { describeEffectiveModelMode } from '@/sync/describeEffectiveModelMode';
import { DEFAULT_AGENT_ID, resolveAgentIdFromFlavor } from '@/agents/catalog';
import type { Session } from '@/sync/storageTypes';

export function resolveDaemonVoiceMediatorModelIds(params: {
    session: Session;
    settings: {
        voiceMediatorChatModelSource?: 'session' | 'custom';
        voiceMediatorChatModelId?: string;
        voiceMediatorCommitModelSource?: 'chat' | 'session' | 'custom';
        voiceMediatorCommitModelId?: string;
    };
}): { chatModelId: string; commitModelId: string } {
    const agentId = resolveAgentIdFromFlavor(params.session.metadata?.flavor) ?? DEFAULT_AGENT_ID;
    const metadata = params.session.metadata ?? null;

    const sessionSelected = (params.session.modelMode ?? 'default') as any;

    const chatSelected =
        params.settings.voiceMediatorChatModelSource === 'session'
            ? sessionSelected
            : (params.settings.voiceMediatorChatModelId ?? 'default');
    const chatModelId = describeEffectiveModelMode({
        agentType: agentId,
        selectedModelId: chatSelected,
        metadata,
    }).effectiveModelId;

    const commitSelected = (() => {
        switch (params.settings.voiceMediatorCommitModelSource) {
            case 'session':
                return sessionSelected;
            case 'custom':
                return params.settings.voiceMediatorCommitModelId ?? 'default';
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

