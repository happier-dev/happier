import { formatAgentLikeIdForDisplay } from '@/agents/catalog/formatAgentLikeIdForDisplay';
import type { TranslationKey } from '@/text';
import type { AgentId } from '@/agents/registry/registryCore';
import { getAgentCore } from '@/agents/registry/registryCore';

export type AgentPickerOption = Readonly<{
    agentId: AgentId;
    title: string;
    subtitleKey: TranslationKey;
    iconName: string;
}>;

/**
 * Legacy picker rows use catalog names and bundled subtitle/icon metadata.
 * Installed Agents are offered through the backend catalog with their own
 * contributed presentation.
 */
export function getAgentPickerOptions(agentIds: readonly AgentId[]): readonly AgentPickerOption[] {
    return agentIds.flatMap((agentId) => {
        const core = getAgentCore(agentId);
        if (!core) return [];
        return [{
            agentId,
            title: formatAgentLikeIdForDisplay(core.id),
            subtitleKey: core.subtitleKey,
            iconName: core.ui.agentPickerIconName,
        }];
    });
}
