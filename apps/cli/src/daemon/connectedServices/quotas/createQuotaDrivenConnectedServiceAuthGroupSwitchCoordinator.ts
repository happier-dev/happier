import type { ConnectedServiceId } from '@happier-dev/protocol';
import type { ConnectedServiceGroupQuotaProbeResult } from './ConnectedServiceQuotasCoordinator';

import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from '../runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';

type DaemonSwitchCoordinatorParams = Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0];

type QuotaDrivenSnapshotCoordinator = Readonly<{
  probeGroupQuotaSnapshots(input: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileIds: ReadonlyArray<string>;
    reason: string;
    deadlineAtMs?: number;
  }>): Promise<ConnectedServiceGroupQuotaProbeResult>;
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
    switchReasonForApplyGeneration: params.switchReasonForApplyGeneration ?? 'pre_turn_group_policy',
    probeQuotaSnapshotsForGroup: async (input) => {
      if (!params.quotaCoordinator) return;
      return await params.quotaCoordinator.probeGroupQuotaSnapshots(input);
    },
  });
}
