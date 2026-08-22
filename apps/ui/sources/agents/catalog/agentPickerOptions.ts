import type { TranslationKey } from '@/text';
import type { AgentId } from '@/agents/registry/registryCore';
import { getAgentCore } from '@/agents/registry/registryCore';

export type AgentPickerOption = Readonly<{
    agentId: AgentId;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: string;
}>;

/**
 * Legacy picker rows are described entirely by bundled translation keys and a
 * bundled icon name, so an externally installed Agent has no row to build here.
 * It is offered through the backend catalog, which carries its own contributed
 * presentation.
 */
export function getAgentPickerOptions(agentIds: readonly AgentId[]): readonly AgentPickerOption[] {
    return agentIds.flatMap((agentId) => {
        const core = getAgentCore(agentId);
        if (!core) return [];
        return [{
            agentId,
            titleKey: core.displayNameKey,
            subtitleKey: core.subtitleKey,
            iconName: core.ui.agentPickerIconName,
        }];
    });
}
