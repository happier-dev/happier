import { ManagedDeleteInputV1Schema, type ManagedMachineActionInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachineReadSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineReferenceCensusV1Schema, type MachineReferenceCensusV1 } from '@happier-dev/protocol/machines/machineReferenceCensusV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { hasProjectedActiveTurnV1 } from '@happier-dev/protocol/sessions/awareness/runtime';
import { readSessionListRowsForServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { storage } from '@/sync/domains/state/storageStore';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

export type ManagedMachineDeleteReview = Readonly<{ machine: ManagedMachineReadSnapshotV1; census: MachineReferenceCensusV1 }>;

/** Name only Sessions already visible to the exact Account opening this review. */
export function describeManagedMachineDeleteWork(scope: ServerAccountScope, machineId: string): string {
    const state = storage.getState();
    const current = state.profileScope;
    const rows = current?.accountId === scope.accountId && areServerProfileIdentifiersEquivalent(current.serverId, scope.serverId)
        ? readSessionListRowsForServerId(state.sessionListRowsByServerId, scope.serverId) : null;
    const names = Object.values(rows ?? {}).flatMap(row => row.archivedAt == null
        && hasProjectedActiveTurnV1(row.latestTurnStatus) && resolveSessionMachineId(row.metadata) === machineId
        ? [getSessionName(row, scope.serverId, { snapshotOnly: true })] : []);
    return names.length > 0
        ? t('managedMachines.dependencies.busySessions', { sessions: names.join(', ') })
        : t('managedMachines.dependencies.activeSessions');
}

/** Both the detail page and composer disclose references to the exact retained row before Delete. */
export function qualifyManagedMachineDeleteReview(machine: ManagedMachineReadSnapshotV1, result: unknown): ManagedMachineDeleteReview | null {
    const parsed = MachineReferenceCensusV1Schema.safeParse(result);
    if (!parsed.success || parsed.data.homeId !== machine.homeId
        || parsed.data.machineId !== null && parsed.data.machineId !== machine.enrolledMachineId) return null;
    return { machine, census: parsed.data };
}

function reviewedTarget(machine: ManagedMachineReadSnapshotV1) {
    return { homeId: machine.homeId, managedId: machine.id, intentRevision: machine.intentRevision,
        controller: machine.controller, resource: machine.resource, enrolledMachineId: machine.enrolledMachineId,
        allocation: machine.allocation, creationState: machine.creationState, archivedAt: machine.archivedAt };
}

/** A changed target or intent needs a new human review; never silently move a reviewed Delete. */
export function buildReviewedManagedMachineDeleteInput(
    machine: ManagedMachineReadSnapshotV1, review: ManagedMachineDeleteReview,
): ManagedMachineActionInputV1<'machines.managed.delete'> | null {
    if (!sameStrictJsonValue(reviewedTarget(machine), reviewedTarget(review.machine))
        || !qualifyManagedMachineDeleteReview(machine, review.census)) return null;
    return ManagedDeleteInputV1Schema.parse({ homeId: machine.homeId, managedId: machine.id,
        when: 'now', expectedRevision: machine.intentRevision, intent: 'delete', reviewedDependencies: true });
}
