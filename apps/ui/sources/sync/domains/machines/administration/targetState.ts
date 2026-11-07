import { MachineAdministrationTargetV1Schema } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import { resolveFleetMachineAvailability } from './fleetUnion';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { formatMachineDisplayNameParts, resolveMachineDisplayNameParts } from '@/utils/sessions/machineDisplayNames';
import type {
    ServerMachineInventorySnapshotV1,
} from '@/sync/domains/machines/machineInventorySnapshots';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';

import type { MachineAdministrationCandidateV1 } from './targetSelection';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureServerProfileScopeResolver, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { isMachineVisibleForLaunchSelection } from '../identity/filterVisibleMachines';
import { compareMachineListOrder } from '../machineListOrder';
import { isMachineAdministrationCandidateSelectable } from './targetSelection';

/**
 * One Administration candidate together with the device-local routing row
 * from which it was observed. `serverId` is presentation/RPC adaptation data
 * only; settings persist the candidate's portable target instead.
 */
export type MachineAdministrationCandidateInventoryRowV1<
    TMachine extends Machine | MachineDisplayRenderable = Machine | MachineDisplayRenderable,
> = Readonly<{
    candidate: MachineAdministrationCandidateV1;
    serverId: string;
    serverName: string;
    machine: TMachine;
}>;

/** Choices omit removed identities; the full candidate inventory still explains a retained selection. */
export function buildMachineAdministrationTargetPickerRows(
    rows: readonly MachineAdministrationCandidateInventoryRowV1<MachineDisplayRenderable>[],
): readonly MachineAdministrationCandidateInventoryRowV1<MachineDisplayRenderable>[] {
    return Object.freeze(rows.filter(row => isMachineVisibleForLaunchSelection(row.machine))
        .sort((left, right) => compareMachineListOrder(
            isMachineAdministrationCandidateSelectable(left.candidate), left.candidate.displayName,
            isMachineAdministrationCandidateSelectable(right.candidate), right.candidate.displayName,
        ) || compareInventoryRows(left, right)));
}

function buildReplacementTarget(
    serverIdentityId: string,
    machine: Readonly<{ replacedByMachineId?: string | null }>,
) {
    const replacementMachineId = String(machine.replacedByMachineId ?? '').trim();
    if (!replacementMachineId) return undefined;
    const parsed = MachineAdministrationTargetV1Schema.safeParse({
        serverIdentityId,
        machineId: replacementMachineId,
    });
    return parsed.success ? Object.freeze(parsed.data) : undefined;
}

function compareInventoryRows<TMachine extends Machine | MachineDisplayRenderable>(
    left: MachineAdministrationCandidateInventoryRowV1<TMachine>,
    right: MachineAdministrationCandidateInventoryRowV1<TMachine>,
): number {
    const serverOrder = left.candidate.target.serverIdentityId.localeCompare(right.candidate.target.serverIdentityId);
    return serverOrder !== 0
        ? serverOrder
        : left.candidate.target.machineId.localeCompare(right.candidate.target.machineId);
}

/**
 * Canonical all-profile Administration projection. Unresolved profile snapshots
 * are intentionally absent from the candidate rows and instead gate sole-target
 * initialization at the caller. Stale rows remain presentation tombstones only.
 */
export function buildMachineAdministrationCandidateInventoryRowsFromSnapshots(params: Readonly<{
    snapshots: readonly ServerMachineInventorySnapshotV1[];
    nowMs?: number;
}>): readonly MachineAdministrationCandidateInventoryRowV1<MachineDisplayRenderable>[] {
    const rows: MachineAdministrationCandidateInventoryRowV1<MachineDisplayRenderable>[] = [];
    let capturedScopeResolver: ProfileScopeResolver | undefined;
    const resolveScopeId: ProfileScopeResolver = id => {
        capturedScopeResolver ??= captureServerProfileScopeResolver();
        return capturedScopeResolver(id);
    };
    for (const snapshot of params.snapshots) {
        if (snapshot.kind !== 'resolved') continue;
        const displayNameParts = resolveMachineDisplayNameParts(snapshot.machines);
        for (const machine of snapshot.machines) {
            const parsedTarget = MachineAdministrationTargetV1Schema.safeParse({
                serverIdentityId: snapshot.serverIdentityId,
                machineId: machine.id,
            });
            if (!parsedTarget.success) continue;
            const machineNameParts = displayNameParts.get(machine.id)!;
            const availability = resolveFleetMachineAvailability(createServerAccountScope(snapshot.serverIdentityId, snapshot.accountId), machine, params.nowMs, resolveScopeId);
            const replacementTarget = availability === 'replaced'
                ? buildReplacementTarget(snapshot.serverIdentityId, machine)
                : undefined;
            const candidate: MachineAdministrationCandidateV1 = Object.freeze({
                target: Object.freeze(parsedTarget.data),
                displayName: formatMachineDisplayNameParts(machineNameParts),
                displayNameParts: machineNameParts,
                serverLabel: snapshot.serverName,
                availability,
                observation: snapshot.observation,
                observedAt: Number.isFinite(machine.updatedAt) ? machine.updatedAt : null,
                ...(replacementTarget ? { replacementTarget } : {}),
            });
            rows.push(Object.freeze({
                candidate,
                serverId: snapshot.profileId,
                serverName: snapshot.serverName,
                machine,
            }));
        }
    }
    return Object.freeze(rows.sort(compareInventoryRows));
}

export function buildMachineAdministrationCandidatesFromSnapshots(params: Readonly<{
    snapshots: readonly ServerMachineInventorySnapshotV1[];
    nowMs?: number;
}>): readonly MachineAdministrationCandidateV1[] {
    return Object.freeze(
        buildMachineAdministrationCandidateInventoryRowsFromSnapshots(params).map((row) => row.candidate),
    );
}
