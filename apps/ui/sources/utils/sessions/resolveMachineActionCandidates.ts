import type { Machine } from '@/sync/domains/state/storageTypes';

import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';

function compareMachinesForPicker(a: Machine, b: Machine): number {
    if (a.active !== b.active) return a.active ? 1 : -1;
    const aActiveAt = typeof a.activeAt === 'number' ? a.activeAt : 0;
    const bActiveAt = typeof b.activeAt === 'number' ? b.activeAt : 0;
    if (aActiveAt !== bActiveAt) return aActiveAt - bActiveAt;
    const aUpdatedAt = typeof a.updatedAt === 'number' ? a.updatedAt : 0;
    const bUpdatedAt = typeof b.updatedAt === 'number' ? b.updatedAt : 0;
    if (aUpdatedAt !== bUpdatedAt) return aUpdatedAt - bUpdatedAt;
    const aCreatedAt = typeof a.createdAt === 'number' ? a.createdAt : 0;
    const bCreatedAt = typeof b.createdAt === 'number' ? b.createdAt : 0;
    return aCreatedAt - bCreatedAt;
}

export function resolveMachineActionCandidates(
    allMachines: readonly Machine[],
    options: Readonly<{ onlineOnly?: boolean; nowMs?: number }> = {},
): Machine[] {
    const onlineOnly = options.onlineOnly ?? true;
    const nowMs = options.nowMs ?? Date.now();
    const bestByLabel = new Map<string, Machine>();

    for (const machine of allMachines) {
        if (onlineOnly && !isMachineOnline(machine, nowMs)) continue;

        const label = (getMachineDisplayName(machine) ?? machine.metadata?.host ?? machine.id).trim();
        if (!label) continue;

        const existing = bestByLabel.get(label);
        if (!existing) {
            bestByLabel.set(label, machine);
            continue;
        }
        if (compareMachinesForPicker(machine, existing) > 0) {
            bestByLabel.set(label, machine);
        }
    }

    return [...bestByLabel.entries()]
        .sort(([aLabel, a], [bLabel, b]) => {
            const labelCmp = aLabel.localeCompare(bLabel);
            if (labelCmp !== 0) return labelCmp;
            return compareMachinesForPicker(b, a);
        })
        .map(([, machine]) => machine);
}
