import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ComposerOptionsInputV1 } from '@happier-dev/protocol/embed';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/runtime-descriptor-compat';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readSessionConnectedServiceBindings } from '@/sync/domains/connectedServices/readSessionConnectedServiceBindings';
import { resolveNewSessionOperationalBackendTarget, resolveNewSessionModelCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { SessionModelDiscoveryContext } from '@/components/sessions/modelPicker/SessionModelDiscoveryDetail';

/** The native catalog identity shared by a Session's picker and option Actions. */
export function buildSessionModelDiscoveryContext(params: Readonly<{
    target: PersistedBackendTargetRefV2 | null;
    agentId: string | null;
    machineId: string | null;
    serverId: string;
    directory: string | null;
    profileId: string | null;
    metadata: ComposerOptionsInputV1 | null;
    settings: Readonly<Record<string, unknown>>;
    accountScope?: ServerAccountScope | null;
    enabled?: boolean;
}>): SessionModelDiscoveryContext {
    return {
        backendTarget: params.target ? resolveNewSessionOperationalBackendTarget({
            backendTarget: params.target, runtimeCarrierAgentId: params.agentId,
        }) : null,
        runtimeCarrierAgentId: params.agentId,
        selectedMachineId: params.machineId,
        capabilityServerId: params.serverId,
        cwd: params.directory,
        enabled: params.enabled,
        probeContext: params.target ? resolveNewSessionModelCapabilityProbeContext({
            backendTarget: params.target,
            runtimeCarrierAgentId: params.agentId,
            settings: params.settings,
            selectedProfileId: params.profileId,
            accountScope: params.accountScope,
            runtimeDescriptorV1: readRuntimeDescriptorV1FromMetadata(params.metadata),
            machineId: params.machineId,
            connectedServices: params.agentId ? readSessionConnectedServiceBindings({ metadata: params.metadata, agentId: params.agentId }) : null,
        }) : null,
    };
}
