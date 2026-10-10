import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import {
    describeEffectiveModelMode,
} from '@/sync/domains/models/describeEffectiveModelMode';
import type { Metadata } from '@happier-dev/session-core/state';

export type DaemonVoiceAgentModelIds = Readonly<{
    chatModelId?: string;
    commitModelId?: string;
}>;

/**
 * Explicit model ids for a daemon voice run. Session choices remain omitted for
 * host admission, or `null` when the target Session's Agent
 * identity is unreadable.
 *
 * `null` is the typed unavailable: with no Agent there is no Agent-owned model
 * fact to report. Substituting the default Agent would describe another Agent's
 * models as this Session's, and an empty Agent id is not a lighter version of
 * that lie — it reaches the backend-target reader and throws. Callers own the
 * unavailable case explicitly.
 */
export function resolveDaemonVoiceAgentModelIds(params: {
    metadata: Metadata | null;
    agent: {
        chatModelSource?: 'session' | 'custom';
        chatModelId?: string;
        commitModelSource?: 'chat' | 'session' | 'custom';
        commitModelId?: string;
    };
}): DaemonVoiceAgentModelIds | null {
    const metadata = params.metadata;
    const agentId = resolveAgentIdFromSessionMetadata(metadata);
    if (!agentId) return null;

    const chatSelected =
        params.agent.chatModelSource === 'session'
            ? undefined
            : (params.agent.chatModelId ?? 'default');
    const chatModelId = chatSelected === undefined ? undefined : describeEffectiveModelMode({
        agentType: agentId,
        selectedModelId: chatSelected,
        metadata,
    }).effectiveModelId;

    const commitSelected = (() => {
        switch (params.agent.commitModelSource) {
            case 'session':
                return undefined;
            case 'custom':
                return params.agent.commitModelId ?? 'default';
            case 'chat':
            default:
                return chatModelId;
        }
    })();

    const commitModelId = commitSelected === undefined ? undefined : describeEffectiveModelMode({
        agentType: agentId,
        selectedModelId: commitSelected,
        metadata,
    }).effectiveModelId;

    return {
        ...(chatModelId === undefined ? {} : { chatModelId }),
        ...(commitModelId === undefined ? {} : { commitModelId }),
    };
}
