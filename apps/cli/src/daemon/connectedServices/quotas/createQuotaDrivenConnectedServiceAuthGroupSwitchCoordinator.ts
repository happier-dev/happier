import type { ConnectedServiceId } from '@happier-dev/protocol';

import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from '../runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';
import type { ConnectedServiceAuthGroupQuotaProbeResult } from '../accountGroups/quotas/preTurnQuotaProbe';

type DaemonSwitchCoordinatorParams = Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0];

type QuotaDrivenSnapshotCoordinator = Readonly<{
    probeGroupQuotaSnapshots(input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileIds: ReadonlyArray<string>;
        reason: string;
    }>): Promise<ConnectedServiceAuthGroupQuotaProbeResult | void>;
}>;

type CreateQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorParams =
    Omit<DaemonSwitchCoordinatorParams, 'probeQuotaSnapshotsForGroup'>
    & Readonly<{
        quotaCoordinator?: QuotaDrivenSnapshotCoordinator | null;
    }>;

export function createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator(
    params: CreateQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorParams,
): ReturnType<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator> {
    return createDaemonConnectedServiceAuthGroupSwitchCoordinator({
        ...params,
        probeQuotaSnapshotsForGroup: async (input) => {
            if (!params.quotaCoordinator) return {
                    status: 'incomplete',
                    requestedProfileCount: input.profileIds.length,
                    completedProfileCount: 0,
                    reason: 'probe_unavailable',
                };
            return await params.quotaCoordinator.probeGroupQuotaSnapshots(input);
        },
    });
}
