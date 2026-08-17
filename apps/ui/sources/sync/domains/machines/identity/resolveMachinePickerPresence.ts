import { isMachineOnline } from '@/utils/sessions/machineUtils';

import { isMachineReplaced } from './machineIdentityTypes';

/**
 * Shared machine presence fact for neutral selection presentations. It does
 * not pick a replacement or make a cached/offline machine executable.
 */
export type MachinePickerPresence =
    | { status: 'online'; selectable: true }
    | { status: 'offline' | 'revoked' | 'replaced'; selectable: false };

export function resolveMachinePickerPresence(
    machine: Readonly<{
        active: boolean;
        activeAt?: number | null;
        revokedAt?: number | null;
        replacedByMachineId?: string | null;
        replacedAt?: unknown;
    }>,
    nowMs?: number,
): MachinePickerPresence {
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
