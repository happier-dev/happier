import type { Machine } from '@/sync/domains/state/storageTypes';

/** Use the published role for Manage. */
export function canManageMachine(machine: Pick<Machine, 'access'> | null | undefined): boolean {
    return machine?.access?.role === 'manage';
}
