import type { ConnectedServiceId } from '@happier-dev/protocol';

import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from '../runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';

type DaemonSwitchCoordinatorParams = Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0];

type QuotaDrivenSnapshotCoordinator = Readonly<{
    probeGroupQuotaSnapshots(input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileIds: ReadonlyArray<string>;
        reason: string;
    }>): Promise<void>;
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
            await params.quotaCoordinator?.probeGroupQuotaSnapshots(input);
        },
    });
}
