import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useSettingsValues } from '@/sync/store/settingsReadHooks';

type AgentUiSettingsDomain = 'runtime' | 'transcriptStorage';

/** Consume dependencies from the same interpreted behavior that will read the selected values. */
export function getAgentUiSettingsKeys(params: Readonly<{
    agentIds: readonly string[];
    machineId?: string | null;
    accountScope?: ServerAccountScope | null;
    domain: AgentUiSettingsDomain;
}>): readonly string[] {
    const keys = new Set<string>();
    for (const agentId of params.agentIds) {
        const behavior = resolveAgentUiBehavior(agentId, params.machineId, params.accountScope).newSession;
        const dependencies = params.domain === 'runtime'
            ? behavior?.configuredRuntimeSettingKeys
            : behavior?.transcriptStorageSettingKeys;
        dependencies?.forEach(key => keys.add(key));
    }
    return [...keys];
}

/** Mounted details subscribe only to the Account facts their Agent descriptors actually read. */
export function useAgentUiSettings(params: Parameters<typeof getAgentUiSettingsKeys>[0]) {
    return useSettingsValues(getAgentUiSettingsKeys(params));
}
