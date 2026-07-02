import type { ConnectedServiceId } from '@happier-dev/protocol';

import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from '../runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';

type DaemonSwitchCoordinatorParams = Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0];

type QuotaDrivenSnapshotCoordinator = Readonly<{
    hydratePersistedQuotaSnapshotsForGroup?(input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileIds: ReadonlyArray<string>;
    }>): Promise<void>;
    probeGroupQuotaSnapshots(input: Readonly<{
        serviceId: ConnectedServiceId;
        groupId: string;
        profileIds: ReadonlyArray<string>;
        reason: string;
    }>): Promise<void>;
}>;

type CreateQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorParams =
    Omit<DaemonSwitchCoordinatorParams, 'hydratePersistedQuotaSnapshotsForGroup' | 'probeQuotaSnapshotsForGroup'>
    & Readonly<{
        quotaCoordinator?: QuotaDrivenSnapshotCoordinator | null;
    }>;

export function createQuotaDrivenConnectedServiceAuthGroupSwitchCoordinator(
    params: CreateQuotaDrivenConnectedServiceAuthGroupSwitchCoordinatorParams,
): ReturnType<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator> {
    return createDaemonConnectedServiceAuthGroupSwitchCoordinator({
        ...params,
        hydratePersistedQuotaSnapshotsForGroup: async (input) => {
            await params.quotaCoordinator?.hydratePersistedQuotaSnapshotsForGroup?.(input);
        },
        probeQuotaSnapshotsForGroup: async (input) => {
            await params.quotaCoordinator?.probeGroupQuotaSnapshots(input);
        },
    });
}
