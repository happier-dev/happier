import type { Machine } from '@/sync/domains/state/storageTypes';

/** Published access owns Manage; explicit legacy custody is the pre-access projection fallback. */
export function canManageMachine(machine: Pick<Machine, 'isShared' | 'access'> | null | undefined): boolean {
    if (!machine) return false;
    return machine.access ? machine.access.role === 'manage' : machine.isShared === false;
}
