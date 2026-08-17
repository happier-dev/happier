import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol';

import type { Machine } from '@/sync/domains/state/storageTypes';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileForPortableIdentity,
    type ServerProfile,
} from '@/sync/domains/server/serverProfiles';

type MachineLike = Readonly<{
    revokedAt?: number | null;
}>;

type MachineWithId = MachineLike & Readonly<{
    id: string;
}>;

/**
 * Resolves the Account-portable target at the existing profile and machine
 * inventory owners. The returned `serverId` is device-local routing data only;
 * callers must never persist it back into the portable target.
 */
export type PortableMachineAdministrationTargetResolution<T extends MachineWithId> =
    | Readonly<{
        kind: 'resolved';
        target: MachineAdministrationTargetV1;
        serverId: string;
        profile: ServerProfile;
        machine: T;
    }>
    | Readonly<{
        kind: 'missingServer';
        target: MachineAdministrationTargetV1;
    }>
    | Readonly<{
        kind: 'ambiguousServer';
        target: MachineAdministrationTargetV1;
        profiles: readonly ServerProfile[];
    }>
    | Readonly<{
        kind: 'missingMachine';
        target: MachineAdministrationTargetV1;
        serverId: string;
        profile: ServerProfile;
    }>;

export function resolveServerScopedMachines<T extends MachineLike>(params: Readonly<{
    serverId: string;
    activeServerId: string;
    serverIdAliases?: readonly string[];
    activeMachines: ReadonlyArray<T>;
    machineListByServerId: Readonly<Record<string, ReadonlyArray<T> | null | undefined>>;
}>): ReadonlyArray<T> | null {
    const activeServerId = String(params.activeServerId ?? '').trim();
    const serverIds = [params.serverId, ...(params.serverIdAliases ?? [])]
        .map((serverId) => String(serverId ?? '').trim())
        .filter((serverId, index, ids) => serverId.length > 0 && ids.indexOf(serverId) === index);
    const targetsActiveServer = activeServerId.length > 0
        && serverIds.some((serverId) => areServerProfileIdentifiersEquivalent(serverId, activeServerId));
    if (targetsActiveServer && params.activeMachines.length > 0) {
        return params.activeMachines;
    }

    const scopedEntries = serverIds
        .filter((serverId) => Object.prototype.hasOwnProperty.call(params.machineListByServerId, serverId))
        .map((serverId) => params.machineListByServerId[serverId]);
    const scopedMachines = scopedEntries.find((machines) => Array.isArray(machines) && machines.length > 0)
        ?? scopedEntries[0];

    if (Array.isArray(scopedMachines) && scopedMachines.length > 0) {
        return scopedMachines;
    }

    if (Array.isArray(scopedMachines)) {
        return scopedMachines;
    }

    return null;
}

/**
 * Looks up one requested machine after server scope resolution. It deliberately
 * does not choose another machine when the requested id is absent.
 */
export function resolveExactServerScopedMachine<T extends MachineWithId>(params: Readonly<{
    machineId: string;
    serverId: string;
    activeServerId: string;
    serverIdAliases?: readonly string[];
    activeMachines: ReadonlyArray<T>;
    machineListByServerId: Readonly<Record<string, ReadonlyArray<T> | null | undefined>>;
}>): T | null {
    const machineId = String(params.machineId ?? '').trim();
    if (!machineId) return null;

    const machines = resolveServerScopedMachines<T>(params);
    return machines?.find((machine) => machine.id === machineId) ?? null;
}

/**
 * Converts an Administration-owned portable `{ serverIdentityId, machineId }`
 * into the incumbent machine-RPC routing pair. It has no active-server or
 * first-machine fallback: unavailable profile correspondence and a missing
 * exact machine remain distinct terminal results for the Administration owner.
 * `resolved` proves correspondence only; revoked/replaced/offline/locked facts
 * still require Administration availability admission before any RPC.
 */
export function resolvePortableMachineAdministrationTarget<T extends MachineWithId>(params: Readonly<{
    target: MachineAdministrationTargetV1;
    activeServerId: string;
    activeMachines: ReadonlyArray<T>;
    machineListByServerId: Readonly<Record<string, ReadonlyArray<T> | null | undefined>>;
}>): PortableMachineAdministrationTargetResolution<T> {
    const profileResolution = resolveServerProfileForPortableIdentity(params.target.serverIdentityId);
    if (profileResolution.kind === 'missing') {
        return Object.freeze({ kind: 'missingServer', target: params.target });
    }
    if (profileResolution.kind === 'ambiguous') {
        return Object.freeze({
            kind: 'ambiguousServer',
            target: params.target,
            profiles: profileResolution.profiles,
        });
    }

    const { profile } = profileResolution;
    const serverIdAliases = [
        params.target.serverIdentityId,
        profile.serverIdentityId,
        ...(profile.legacyServerIds ?? []),
    ].filter((serverId, index, ids): serverId is string => (
        typeof serverId === 'string'
        && serverId.trim().length > 0
        && serverId !== profile.id
        && ids.indexOf(serverId) === index
    ));
    const machine = resolveExactServerScopedMachine<T>({
        machineId: params.target.machineId,
        serverId: profile.id,
        serverIdAliases,
        activeServerId: params.activeServerId,
        activeMachines: params.activeMachines,
        machineListByServerId: params.machineListByServerId,
    });
    if (!machine) {
        return Object.freeze({
            kind: 'missingMachine',
            target: params.target,
            serverId: profile.id,
            profile,
        });
    }

    return Object.freeze({
        kind: 'resolved',
        target: params.target,
        serverId: profile.id,
        profile,
        machine,
    });
}

export function filterVisibleMachines<T extends MachineLike>(machines: ReadonlyArray<T>): T[] {
    return machines.filter((machine) => {
        const revokedAt = machine.revokedAt;
        return !(typeof revokedAt === 'number' && Number.isFinite(revokedAt) && revokedAt > 0);
    });
}
