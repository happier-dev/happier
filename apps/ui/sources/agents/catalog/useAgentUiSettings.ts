import { resolveAgentUiBehavior } from '@/agents/registry/registryUiBehavior';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useSettingsValues } from '@/sync/store/settingsReadHooks';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

type AgentUiSettingsDomain = 'runtime' | 'transcriptStorage' | 'availability';

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
            : params.domain === 'availability'
                ? behavior?.availabilitySettingKeys
                : behavior?.transcriptStorageSettingKeys;
        dependencies?.forEach(key => keys.add(key));
    }
    return [...keys];
}

/** Mounted details subscribe only to the Account facts their Agent descriptors actually read. */
export function useAgentUiSettings(params: Parameters<typeof getAgentUiSettingsKeys>[0]) {
    return useSettingsValues(getAgentUiSettingsKeys(params));
}

/** Source-instance materialization reads only the Agent's declared setting ids. */
export function useExternalSessionBrowseSettings(
    projection: PluginProjectionV2 | null | undefined,
    agentIds: readonly string[],
) {
    const keys = new Set<string>();
    for (const agentId of agentIds) {
        for (const source of projection?.agentsById[agentId]?.externalSessions?.sources ?? []) {
            for (const instance of source.instances ?? []) {
                if (instance.kind !== 'agentSetting' && instance.kind !== 'agentSettingOverride') continue;
                if (instance.settingId) keys.add(instance.settingId);
                if (instance.byServerIdSettingId) keys.add(instance.byServerIdSettingId);
            }
        }
    }
    return useSettingsValues([...keys]);
}
