import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';

import { resolveQualifiedConnectedAccountServiceForIngressServiceId } from '@/plugins/projection/registry/connectedAccountPurposeCompatibility';

import { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import type { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from '../runtimeAuth/createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';

type SpawnInput = Parameters<typeof resolveConnectedServiceAuthForSpawn>[0];
type CoordinatorOptions = Parameters<typeof createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator>[0];

export type ExecutionRunAuthGroupCoordinatorFactory = (input: Readonly<{
    serviceId: ConnectedAccountServiceKey;
    reason: string;
    applyGeneration: CoordinatorOptions['applyGeneration'];
}>) => Promise<ReturnType<typeof createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator> | null>;

// The Run materializes the committed generation into its own activation. Pool
// selection must not perform native application on the parent Session.
export const acknowledgeExecutionRunAuthGroupGeneration: CoordinatorOptions['applyGeneration'] = async () => ({ ok: true });

export async function resolveExecutionRunAuthForSpawn(
    input: SpawnInput,
    createCoordinator: ExecutionRunAuthGroupCoordinatorFactory,
) {
    const prepareCoordinator = async (serviceId: ConnectedAccountServiceKey, reason: string) => {
        const service = resolveQualifiedConnectedAccountServiceForIngressServiceId(serviceId);
        if (!service) return null;
        const coordinator = await createCoordinator({ serviceId, reason,
            applyGeneration: acknowledgeExecutionRunAuthGroupGeneration });
        return coordinator ? { service, coordinator } : null;
    };
    return await resolveConnectedServiceAuthForSpawn({
        ...input,
        authGroupSwitchCoordinator: {
            async switchBeforeTurn(request) {
                const target = await prepareCoordinator(request.serviceId, 'execution_run_pre_turn');
                if (!target) return { status: 'qualified_connected_account_v4_unavailable' };
                return await target.coordinator.switchBeforeTurn({ ...request, signal: input.signal, serviceId: target.service });
            },
            async switchAfterClassifiedFailure(request) {
                const target = await prepareCoordinator(request.serviceId, 'execution_run_refresh_failed');
                if (!target) return { status: 'qualified_connected_account_v4_unavailable' };
                return await target.coordinator.switchAfterClassifiedFailure({ ...request, serviceId: target.service });
            },
        },
    });
}
