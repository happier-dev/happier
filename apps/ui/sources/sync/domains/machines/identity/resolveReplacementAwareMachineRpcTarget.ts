import type { Machine } from '@/sync/domains/state/storageTypes';

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
    machines: ReadonlyArray<Machine>;
}>): ReplacementAwareMachineRpcTarget | null {
    const originMachineId = normalizeMachineIdentityString(input.machineId);
    if (!originMachineId || originMachineId.startsWith('host:')) return null;

    const machineById = new Map(input.machines.map((machine) => [machine.id, machine] as const));
    const originMachine = machineById.get(originMachineId);
    if (!originMachine) {
        return {
            machineId: originMachineId,
            originMachineId,
            replaced: false,
        };
    }

    const canonical = resolveCanonicalMachineId(originMachineId, input.machines);
    if (!canonical || canonical.reason === 'missingReplacementTarget') return null;

    const targetMachine = machineById.get(canonical.machineId);
    if (targetMachine && (isMachineRevoked(targetMachine) || isMachineReplaced(targetMachine))) return null;

    return {
        machineId: canonical.machineId,
        originMachineId,
        replaced: canonical.machineId !== originMachineId,
    };
}
