import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineReplaced } from '@/sync/domains/machines/identity/machineIdentityTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

export type MachinePickerPresence =
    | { status: 'online'; selectable: true }
    | { status: 'offline' | 'revoked' | 'replaced'; selectable: false };

export function resolveMachinePickerPresence(machine: Machine, nowMs?: number): MachinePickerPresence {
    const revokedAt = typeof machine.revokedAt === 'number' ? machine.revokedAt : 0;
    if (Number.isFinite(revokedAt) && revokedAt > 0) {
        return { status: 'revoked', selectable: false };
    }

    if (isMachineReplaced(machine)) {
        return { status: 'replaced', selectable: false };
    }

    if (!isMachineOnline(machine, nowMs)) {
        return { status: 'offline', selectable: false };
    }

    return { status: 'online', selectable: true };
}
