import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';

import { resolveQualifiedConnectedAccountServiceForIngressServiceId } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';

import { ConnectedServiceSpawnAuthGroupAuthorityError, resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';
import type { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from './runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';

type SpawnInput = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0];
type CoordinatorOptions = Parameters<typeof createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator>[0];

export type ConnectedServiceLaunchAuthGroupCoordinatorFactory = (input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    reason: string;
    applyGeneration: CoordinatorOptions['applyGeneration'];
    prepareCandidateForSwitch?: CoordinatorOptions['prepareCandidateForSwitch'];
}>) => Promise<ReturnType<typeof createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator> | null>;

// Every launch materializes the committed generation into its new process.
// Selection cannot apply native credentials to an existing or parent Session.
export const acknowledgeConnectedServiceLaunchGeneration: CoordinatorOptions['applyGeneration'] = async () => ({ ok: true });

export async function resolveConnectedServiceAuthForLaunch(
    input: SpawnInput,
    createCoordinator: ConnectedServiceLaunchAuthGroupCoordinatorFactory,
) {
    const prepareCoordinator = async (serviceId: ConnectedAccountServiceKey, groupId: string, reason: string,
        prepareCandidateForSwitch?: CoordinatorOptions['prepareCandidateForSwitch']) => {
        const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(serviceId);
        if (!service) throw new ConnectedServiceSpawnAuthGroupAuthorityError({ kind: 'resolution_unavailable', serviceId, groupId });
        const coordinator = await createCoordinator({ serviceId, reason, prepareCandidateForSwitch,
            applyGeneration: acknowledgeConnectedServiceLaunchGeneration });
        if (!coordinator) throw new ConnectedServiceSpawnAuthGroupAuthorityError({ kind: 'resolution_unavailable', serviceId, groupId });
        return { service, coordinator };
    };
    return await resolveConnectedServiceAuthForSpawn({
        ...input,
        authGroupSwitchCoordinator: {
            async switchBeforeTurn(request) {
                const { prepareCandidateForSwitch, ...selection } = request;
                const target = await prepareCoordinator(request.serviceId, request.groupId, 'spawn_pre_turn', prepareCandidateForSwitch);
                return await target.coordinator.switchBeforeTurn({ ...selection, signal: input.signal, serviceId: target.service });
            },
            async switchAfterClassifiedFailure(request) {
                const target = await prepareCoordinator(request.serviceId, request.groupId, 'spawn_refresh_failed');
                return await target.coordinator.switchAfterClassifiedFailure({ ...request, serviceId: target.service });
            },
        },
    });
}
