import type { Session } from '@/sync/domains/state/storageTypes';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';

/** A settled exact-Home inventory, rather than runtime reachability, owns this display fact. */
export function isSessionMachineAccessRemoved(input: Readonly<{
    session: Pick<Session, 'access' | 'accessLevel'> | null | undefined;
    machineId: string | null | undefined;
    inventorySettled: boolean;
    machinePresent: boolean;
}>): boolean {
    return Boolean(input.session && isSessionAccessOwner(input.session.access, input.session.accessLevel)
        && input.machineId && input.inventorySettled && !input.machinePresent);
}
