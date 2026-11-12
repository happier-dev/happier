import type { BackendTargetRefV1 } from '@happier-dev/protocol/backends/targets/backendTargetRef';
import { readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { supportsAgentVoiceFunctions } from '@happier-dev/protocol/plugins/contributions/agentSessionCapabilities';
import { getBundledAgentDeclaration } from '@/agents/catalog/catalog';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

/** Both catalogs carry the authored Agent descriptor; neither invents Voice eligibility. */
export function isVoiceAgentSupported(
    agentId: string,
    projection?: PluginProjectionV2 | null,
): boolean {
    return supportsAgentVoiceFunctions(projection?.agentsById[agentId]?.capabilities
        ?? getBundledAgentDeclaration(agentId)?.capabilities);
}

export async function assertVoiceAgentBackendTargetSupported(params: Readonly<{
    target: BackendTargetRefV1;
    machineId: string | null | undefined;
    serverId: string;
    signal?: AbortSignal;
}>): Promise<void> {
    const backendId = readBackendTargetRefV2(params.target).backendId;
    // Bundled declarations are already admitted by the build-owned publisher.
    // External Agents consume the selected Machine's admitted projection.
    const projection = getBundledAgentDeclaration(backendId) ? null
        : (await loadDaemonMergedProjectionInputs({ machineId: params.machineId,
            serverId: params.serverId, signal: params.signal,
            sections: ['agentsById', 'installedPackagesById'] }))?.pluginProjectionV2;
    params.signal?.throwIfAborted();
    if (!isVoiceAgentSupported(backendId, projection)) {
        throw Object.assign(new Error('voice_agent_selection_unavailable'), { code: 'VOICE_AGENT_SELECTION_UNAVAILABLE' });
    }
}
