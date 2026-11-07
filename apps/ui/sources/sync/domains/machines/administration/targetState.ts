import { MachineAdministrationTargetV1Schema } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { resolveFleetMachineAvailability } from './fleetUnion';
import { isManagedMachineResourceAbsent } from '@/components/settings/machines/managed/managedMachineResource';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { formatMachineDisplayNameParts, resolveMachineDisplayNameParts } from '@/utils/sessions/machineDisplayNames';
import type {
    ServerMachineInventorySnapshotV1,
} from '@/sync/domains/machines/machineInventorySnapshots';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import { readMachineInventoryRowReadiness } from '@/sync/domains/machines/resolveServerScopedMachines';
import type { MachineInventoryFactsSelector } from '@/sync/domains/machines/useMachineInventorySnapshots';

import type { MachineAdministrationCandidateV1 } from './targetSelection';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureServerProfileScopeResolver, type ProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import { isMachineVisibleForLaunchSelection } from '../identity/filterVisibleMachines';
import { compareMachineListOrder } from '../machineListOrder';
import { isMachineAdministrationCandidateSelectable } from './targetSelection';

/** Target-only surfaces read labels and eligibility, rather than Machine content revisions. */
export const readMachineAdministrationTargetFacts: MachineInventoryFactsSelector = (machine, scope, nowMs) => {
    const availability = resolveFleetMachineAvailability(scope, machine, nowMs);
    return [machine.id, machine.kind, machine.metadata === null, machine.metadata?.displayName, machine.metadata?.host,
        machine.metadata?.platform, machine.isShared, machine.availability?.kind,
        machine.availability?.kind === 'locked' ? machine.availability.reason : null,
        readMachineInventoryRowReadiness(machine), availability, machine.replacedByMachineId,
        availability === 'online' ? null : machine.updatedAt];
};

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

/** Choices omit removed identities/resources; the full inventory still explains a retained selection. */
export function buildMachineAdministrationTargetPickerRows(
    rows: readonly MachineAdministrationCandidateInventoryRowV1<MachineDisplayRenderable>[],
): readonly MachineAdministrationCandidateInventoryRowV1<MachineDisplayRenderable>[] {
    return Object.freeze(rows.filter(row => isMachineVisibleForLaunchSelection(row.machine) && row.candidate.availability !== 'missing')
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
    /** Account-scoped enrollment index supplied by the managed inventory owner. */
    managedMachinesByServerId?: Readonly<Record<string, Readonly<Record<string, ManagedMachineV1>>>>;
    nowMs?: number;
    previous?: Readonly<{
        snapshots: readonly ServerMachineInventorySnapshotV1[];
        rows: readonly MachineAdministrationCandidateInventoryRowV1<MachineDisplayRenderable>[];
    }>;
}>): readonly MachineAdministrationCandidateInventoryRowV1<MachineDisplayRenderable>[] {
    const rows: MachineAdministrationCandidateInventoryRowV1<MachineDisplayRenderable>[] = [];
    const previousSnapshots = new Map(params.previous?.snapshots.flatMap(snapshot => snapshot.kind === 'resolved'
        ? [[snapshot.serverIdentityId, snapshot] as const] : []));
    const previousRowsByHome = new Map<string, Map<string, MachineAdministrationCandidateInventoryRowV1<MachineDisplayRenderable>>>();
    for (const row of params.previous?.rows ?? []) {
        let homeRows = previousRowsByHome.get(row.candidate.target.serverIdentityId);
        if (!homeRows) previousRowsByHome.set(row.candidate.target.serverIdentityId, homeRows = new Map());
        homeRows.set(row.candidate.target.machineId, row);
    }
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
            const managed = params.managedMachinesByServerId?.[snapshot.profileId]?.[machine.id];
            const availability = managed && isManagedMachineResourceAbsent(managed) ? 'missing'
                : resolveFleetMachineAvailability(createServerAccountScope(snapshot.serverIdentityId, snapshot.accountId), machine, params.nowMs, resolveScopeId);
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
            const previousSnapshot = previousSnapshots.get(snapshot.serverIdentityId);
            const previous = previousSnapshot?.accountId === snapshot.accountId
                ? previousRowsByHome.get(snapshot.serverIdentityId)?.get(machine.id) : undefined;
            if (previous && previous.machine === machine && previous.serverId === snapshot.profileId
                && previous.serverName === snapshot.serverName
                && previous.candidate.displayName === candidate.displayName
                && previous.candidate.displayNameParts?.name === candidate.displayNameParts?.name
                && previous.candidate.displayNameParts?.hint === candidate.displayNameParts?.hint
                && previous.candidate.availability === candidate.availability
                && previous.candidate.observation === candidate.observation
                && previous.candidate.observedAt === candidate.observedAt
                && previous.candidate.replacementTarget?.machineId === candidate.replacementTarget?.machineId) {
                rows.push(previous);
                continue;
            }
            rows.push(Object.freeze({
                candidate,
                serverId: snapshot.profileId,
                serverName: snapshot.serverName,
                machine,
            }));
        }
    }
    rows.sort(compareInventoryRows);
    return params.previous?.rows.length === rows.length && rows.every((row, index) => row === params.previous?.rows[index])
        ? params.previous.rows : Object.freeze(rows);
}

export function buildMachineAdministrationCandidatesFromSnapshots(params: Readonly<{
    snapshots: readonly ServerMachineInventorySnapshotV1[];
    nowMs?: number;
}>): readonly MachineAdministrationCandidateV1[] {
    return Object.freeze(
        buildMachineAdministrationCandidateInventoryRowsFromSnapshots(params).map((row) => row.candidate),
    );
}
