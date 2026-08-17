import { MachineAdministrationTargetV1Schema } from '@happier-dev/protocol';

import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerProfile } from '@/sync/domains/server/serverProfiles';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import type {
    ServerMachineInventorySnapshotV1,
} from '@/sync/domains/machines/machineInventorySnapshots';
import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';

import type { MachineAdministrationCandidateV1 } from './targetSelection';

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
    for (const snapshot of params.snapshots) {
        if (snapshot.kind !== 'resolved') continue;
        for (const machine of snapshot.machines) {
            const parsedTarget = MachineAdministrationTargetV1Schema.safeParse({
                serverIdentityId: snapshot.serverIdentityId,
                machineId: machine.id,
            });
            if (!parsedTarget.success) continue;
            const presence = resolveMachinePickerPresence(machine, params.nowMs);
            const availability = machine.availability?.kind === 'locked'
                ? 'locked' as const
                : presence.status;
            const replacementTarget = availability === 'replaced'
                ? buildReplacementTarget(snapshot.serverIdentityId, machine)
                : undefined;
            const candidate: MachineAdministrationCandidateV1 = Object.freeze({
                target: Object.freeze(parsedTarget.data),
                displayName: getMachineDisplayName(machine) ?? machine.id,
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

/**
 * Projects currently hydrated raw machine records into portable Administration
 * candidates. It deliberately does not select a target and does not promote a
 * device-local profile without canonical server identity.
 *
 * The caller must supply the raw inventory, not the launch/visible-machine
 * projection, so revoked and replaced rows remain available as tombstones.
 */
export function buildMachineAdministrationCandidateInventoryRows(params: Readonly<{
    profiles: readonly ServerProfile[];
    activeServerId: string;
    activeMachineRecords: readonly Machine[];
    machineRecordListsByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    nowMs?: number;
}>): readonly MachineAdministrationCandidateInventoryRowV1<Machine>[] {
    const rowsByTarget = new Map<string, MachineAdministrationCandidateInventoryRowV1<Machine>>();
    const profileClaimsByIdentity = new Map<string, Set<string>>();
    for (const profile of params.profiles) {
        const claimedIdentities = [profile.serverIdentityId, ...(profile.legacyServerIds ?? [])]
            .filter((identity): identity is string => (
                typeof identity === 'string'
                && MachineAdministrationTargetV1Schema.shape.serverIdentityId.safeParse(identity).success
            ));
        for (const identity of claimedIdentities) {
            const profileIds = profileClaimsByIdentity.get(identity) ?? new Set<string>();
            profileIds.add(profile.id);
            profileClaimsByIdentity.set(identity, profileIds);
        }
    }

    for (const profile of params.profiles) {
        const serverIdentityId = profile.serverIdentityId ?? '';
        if (!MachineAdministrationTargetV1Schema.shape.serverIdentityId.safeParse(serverIdentityId).success) {
            continue;
        }
        if (profileClaimsByIdentity.get(serverIdentityId)?.size !== 1) continue;
        const machines = resolveServerScopedMachines({
            serverId: profile.id,
            serverIdAliases: [serverIdentityId, ...(profile.legacyServerIds ?? [])],
            activeServerId: params.activeServerId,
            activeMachines: params.activeMachineRecords,
            machineListByServerId: params.machineRecordListsByServerId,
        }) ?? [];

        for (const machine of machines) {
            const target = MachineAdministrationTargetV1Schema.parse({
                serverIdentityId,
                machineId: machine.id,
            });
            const presence = resolveMachinePickerPresence(machine, params.nowMs);
            const availability = machine.availability?.kind === 'locked'
                ? 'locked' as const
                : presence.status;
            const replacementTarget = availability === 'replaced'
                ? buildReplacementTarget(serverIdentityId, machine)
                : undefined;
            const candidate: MachineAdministrationCandidateV1 = Object.freeze({
                target: Object.freeze(target),
                displayName: getMachineDisplayName(machine) ?? machine.id,
                serverLabel: profile.name || profile.serverUrl || profile.id,
                availability,
                observation: 'live',
                observedAt: Number.isFinite(machine.updatedAt) ? machine.updatedAt : null,
                ...(replacementTarget ? { replacementTarget } : {}),
            });
            const key = `${serverIdentityId}\u0000${machine.id}`;
            if (!rowsByTarget.has(key)) {
                rowsByTarget.set(key, Object.freeze({
                    candidate,
                    serverId: profile.id,
                    serverName: candidate.serverLabel,
                    machine,
                }));
            }
        }
    }

    return Object.freeze([...rowsByTarget.values()].sort(compareInventoryRows));
}

export function buildMachineAdministrationCandidates(params: Readonly<{
    profiles: readonly ServerProfile[];
    activeServerId: string;
    activeMachineRecords: readonly Machine[];
    machineRecordListsByServerId: Readonly<Record<string, readonly Machine[] | null | undefined>>;
    nowMs?: number;
}>): readonly MachineAdministrationCandidateV1[] {
    return Object.freeze(buildMachineAdministrationCandidateInventoryRows(params).map((row) => row.candidate));
}

export function buildMachineAdministrationCandidatesFromSnapshots(params: Readonly<{
    snapshots: readonly ServerMachineInventorySnapshotV1[];
    nowMs?: number;
}>): readonly MachineAdministrationCandidateV1[] {
    return Object.freeze(
        buildMachineAdministrationCandidateInventoryRowsFromSnapshots(params).map((row) => row.candidate),
    );
}
