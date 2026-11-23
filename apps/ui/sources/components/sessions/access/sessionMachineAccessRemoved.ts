import type { Session } from '@/sync/domains/state/storageTypes';

/** The access-loss owner publishes this stop reason at the Session's natural boundary. */
export function isSessionMachineAccessRemoved(input: Readonly<{
    session: Pick<Session, 'active' | 'metadata'> | null | undefined;
}>): boolean {
    return input.session?.active === false
        && input.session.metadata?.lifecycleStateReason === 'machine_access_withdrawn';
}
