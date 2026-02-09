import type { TranslationKey } from '@/text';
import type { AgentId } from '@/agents/registry/registryCore';
import { getAgentCore } from '@/agents/registry/registryCore';

export type AgentPickerOption = Readonly<{
    agentId: AgentId;
    titleKey: TranslationKey;
    subtitleKey: TranslationKey;
    iconName: string;
}>;

export function getAgentPickerOptions(agentIds: readonly AgentId[]): readonly AgentPickerOption[] {
    return agentIds.map((agentId) => {
        const core = getAgentCore(agentId);
        return {
            agentId,
            titleKey: core.displayNameKey,
            subtitleKey: core.subtitleKey,
            iconName: core.ui.agentPickerIconName,
        };
    });
}
