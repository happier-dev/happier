import type {
    ConnectedServiceId,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import type { TrackedSession } from '@/daemon/types';

import type { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '../accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { parseConnectedServiceBindingSelections } from '../parseConnectedServicesBindings';
type QuotaCoordinatorLike = Readonly<{
    recordInBandQuotaSnapshot(input: Readonly<{
        serviceId: ConnectedServiceId;
        profileId: string;
        snapshot: ConnectedServiceQuotaSnapshotV1;
    }>): Promise<unknown>;
}>;

function normalizeSessionId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function findTrackedSession(
    children: ReadonlyArray<TrackedSession>,
    sessionId: string,
): TrackedSession | null {
    const normalized = normalizeSessionId(sessionId);
    if (!normalized) return null;
    return children.find((child) => normalizeSessionId(child.happySessionId) === normalized) ?? null;
}

export async function recordConnectedServiceRuntimeQuotaSnapshotForSession(input: Readonly<{
    getChildren: () => ReadonlyArray<TrackedSession>;
    quotaCoordinator: QuotaCoordinatorLike | null;
    runtimeQuotaSnapshots: ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore;
    sessionId: string;
    serviceId: ConnectedServiceId;
    snapshot: ConnectedServiceQuotaSnapshotV1;
}>): Promise<
    | Readonly<{ status: 'recorded'; groupRuntimeStateRecorded: boolean; quotaStateRecorded: boolean }>
    | Readonly<{ status: 'service_id_mismatch' }>
    | Readonly<{ status: 'session_not_found' }>
    | Readonly<{ status: 'not_connected_selection' }>
> {
    if (input.snapshot.serviceId !== input.serviceId) return { status: 'service_id_mismatch' };

    const tracked = findTrackedSession(input.getChildren(), input.sessionId);
    if (!tracked) return { status: 'session_not_found' };
    const selection = parseConnectedServiceBindingSelections(tracked.spawnOptions?.connectedServices)
        .find((candidate) => candidate.serviceId === input.serviceId) ?? null;
    if (!selection) return { status: 'not_connected_selection' };

    if (selection.kind !== 'group') {
        let quotaStateRecorded = false;
        if (input.quotaCoordinator) {
            try {
                await input.quotaCoordinator.recordInBandQuotaSnapshot({
                    serviceId: input.serviceId,
                    profileId: input.snapshot.profileId,
                    snapshot: input.snapshot,
                });
                quotaStateRecorded = true;
            } catch {
                quotaStateRecorded = false;
            }
        }
        return { status: 'recorded', groupRuntimeStateRecorded: false, quotaStateRecorded };
    }

    input.runtimeQuotaSnapshots.recordSnapshot({
        serviceId: input.serviceId,
        groupId: selection.groupId,
        profileId: input.snapshot.profileId,
        snapshot: input.snapshot,
    });

    let quotaStateRecorded = false;
    if (input.quotaCoordinator) {
        try {
            await input.quotaCoordinator.recordInBandQuotaSnapshot({
                serviceId: input.serviceId,
                profileId: input.snapshot.profileId,
                snapshot: input.snapshot,
            });
            quotaStateRecorded = true;
        } catch {
            quotaStateRecorded = false;
        }
    }
    return { status: 'recorded', groupRuntimeStateRecorded: true, quotaStateRecorded };
}
