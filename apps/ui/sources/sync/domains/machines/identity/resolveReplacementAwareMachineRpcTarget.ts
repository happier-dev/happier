import type { Machine } from '@/sync/domains/state/storageTypes';

import { findMachineInCollection, type MachineCollection } from './machineCollection';
import { isMachineReplaced, normalizeMachineIdentityString } from './machineIdentityTypes';
import { resolveCanonicalMachineId } from './resolveCanonicalMachineId';

export type ReplacementAwareMachineRpcTarget = Readonly<{
    machineId: string;
    originMachineId: string;
    replaced: boolean;
}>;

function isMachineRevoked(machine: Readonly<{ revokedAt?: unknown }> | null | undefined): boolean {
    return typeof machine?.revokedAt === 'number' && Number.isFinite(machine.revokedAt) && machine.revokedAt > 0;
}

export function resolveReplacementAwareMachineRpcTarget(input: Readonly<{
    machineId?: string | null;
    machines: MachineCollection<Machine>;
}>): ReplacementAwareMachineRpcTarget | null {
    const originMachineId = normalizeMachineIdentityString(input.machineId);
    if (!originMachineId || originMachineId.startsWith('host:')) return null;

    const originMachine = findMachineInCollection(input.machines, originMachineId);
    if (!originMachine) {
        return {
            machineId: originMachineId,
            originMachineId,
            replaced: false,
        };
    }

    const canonical = resolveCanonicalMachineId(originMachineId, input.machines);
    if (!canonical || canonical.reason === 'missingReplacementTarget') return null;

    const targetMachine = findMachineInCollection(input.machines, canonical.machineId);
    if (targetMachine && (isMachineRevoked(targetMachine) || isMachineReplaced(targetMachine))) return null;

    return {
        machineId: canonical.machineId,
        originMachineId,
        replaced: canonical.machineId !== originMachineId,
    };
}
