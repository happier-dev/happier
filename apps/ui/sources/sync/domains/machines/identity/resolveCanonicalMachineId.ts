import { findMachineInCollection, type MachineCollection } from './machineCollection';
import {
    isMachineReplaced,
    normalizeMachineIdentityString,
    type CanonicalMachineResolution,
} from './machineIdentityTypes';

const MAX_REPLACEMENT_CHAIN_LENGTH = 16;

export type MachineReplacementRecord = Readonly<{
    id: string;
    replacedByMachineId?: string | null;
    replacedAt?: unknown;
}>;

export function resolveCanonicalMachineId(
    machineIdInput: string | null | undefined,
    machines: MachineCollection<MachineReplacementRecord>,
): CanonicalMachineResolution | null {
    const machineId = normalizeMachineIdentityString(machineIdInput);
    if (!machineId) return null;
    if (machineId.startsWith('host:')) return null;

    const chain: string[] = [];
    const visited = new Set<string>();
    let currentMachineId = machineId;

    for (let depth = 0; depth < MAX_REPLACEMENT_CHAIN_LENGTH; depth += 1) {
        if (visited.has(currentMachineId)) return null;
        visited.add(currentMachineId);
        chain.push(currentMachineId);

        const machine = findMachineInCollection(machines, currentMachineId);
        if (!machine || !isMachineReplaced(machine)) {
            return {
                machineId: currentMachineId,
                reason: currentMachineId === machineId ? 'direct' : 'replacement',
                chain,
            };
        }

        const replacementMachineId = normalizeMachineIdentityString(machine.replacedByMachineId);
        if (!replacementMachineId || replacementMachineId === currentMachineId) return null;
        if (!findMachineInCollection(machines, replacementMachineId)) {
            return {
                machineId: currentMachineId,
                reason: 'missingReplacementTarget',
                chain,
            };
        }
        currentMachineId = replacementMachineId;
    }

    return null;
}
