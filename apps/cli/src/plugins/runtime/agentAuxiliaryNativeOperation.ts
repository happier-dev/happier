import { PluginError } from '@happier-dev/plugin-sdk/errors';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { prepareRequesterNativeOperation } from '@/daemon/agentIsolation/prepareNativeOperation';
import { resolveAgentLaunchNativeEnvironment } from '@/daemon/agentIsolation/agentLaunchRuntime';
import type { RequesterWorkAttributionV1 } from '@/daemon/lifecycle/requesterWorkAttribution';

/** Auxiliary native reads own a finite lease, independently of any live Session. */
export async function prepareAgentAuxiliaryNativeOperation(input: Readonly<{
    machine: HostAgentIsolationLaunchContext;
    requester: RequesterWorkAttributionV1 | undefined;
    correlationId: string;
    signal: AbortSignal;
}>) {
    const requester = input.requester;
    if (!requester) throw new PluginError({ code: 'agent_isolation_unavailable',
        message: 'Auxiliary Agent requester is unavailable', retryable: false,
        details: { reason: 'requester_authority_unavailable', phase: 'native_execution_preparation' } });
    let material: ReturnType<Parameters<typeof prepareRequesterNativeOperation>[0]['readMaterial']>;
    return await prepareRequesterNativeOperation({
        requesterIdentity: { kind: 'isolated', requester, separationRequired: false },
        signal: input.signal,
        readMaterial(identity) {
            material ??= { materializationKey: input.correlationId, selectedMaterials: [],
                environment: resolveAgentLaunchNativeEnvironment(identity.home) };
            return material;
        },
    }, { machine: input.machine, homeServerIdentityId: requester.serverId,
        machineId: requester.machineId, installationId: requester.installationId });
}
