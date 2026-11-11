import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { BackendTargetRefV1 } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { resolveVoiceSessionAgentSelection } from './resolveVoiceSessionAgentSelection';
import {
    describeEffectiveModelMode,
} from '@/sync/domains/models/describeEffectiveModelMode';
import type { Metadata } from '@happier-dev/session-core/state';
import { isModelSelectableForSession } from '@/sync/domains/models/modelOptions';
import { getAgentModelConfig } from '@happier-dev/agents';

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
    admittedAgentTarget?: BackendTargetRefV1;
    agent: {
        chatModelSource?: 'session' | 'custom';
        chatModelId?: string;
        commitModelSource?: 'chat' | 'session' | 'custom';
        commitModelId?: string;
    };
}): DaemonVoiceAgentModelIds | null {
    const metadata = params.metadata;
    const selection = params.admittedAgentTarget
        ? { ok: true as const, backendTarget: params.admittedAgentTarget }
        : resolveVoiceSessionAgentSelection(metadata);
    const agentId = selection.ok ? readBackendTargetRefV2(selection.backendTarget).backendId : null;
    if (!agentId) return null;
    const modelConfig = getAgentModelConfig(agentId);

    const resolveCustomModel = (modelId: string) => describeEffectiveModelMode({
        agentType: agentId,
        // Installed Agents without catalog model policy validate their own custom ids.
        selectedModelId: modelId === 'default' || !modelConfig || isModelSelectableForSession(agentId, metadata, modelId)
            ? modelId : 'default',
        metadata,
    }).effectiveModelId;

    const chatSelected =
        params.agent.chatModelSource === 'session'
            ? undefined
            : (params.agent.chatModelId ?? 'default');
    const chatModelId = chatSelected === undefined ? undefined : resolveCustomModel(chatSelected);

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

    const commitModelId = commitSelected === undefined ? undefined : resolveCustomModel(commitSelected);

    return {
        ...(chatModelId === undefined ? {} : { chatModelId }),
        ...(commitModelId === undefined ? {} : { commitModelId }),
    };
}
