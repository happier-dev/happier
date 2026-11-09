import type { SessionInitialAccessDraftV1 } from '@happier-dev/protocol/sessions/access/sessionInitialAccessDraftV1';

export type SessionAccessDraftReconciliation = Readonly<{
    access: SessionInitialAccessDraftV1 | null;
    /** Principals dropped because they cannot exist in the new target Home. */
    removedCount: number;
    changed: boolean;
}>;

const UNCHANGED_EMPTY: SessionAccessDraftReconciliation = Object.freeze({
    access: null, removedCount: 0, changed: false,
});

/**
 * Reconciles a creation access draft when the target Home changes.
 *
 * Account, Team and Group identifiers are Home-local: the same string in
 * another Home is a different subject or none at all. Carrying them across a
 * Home change would either silently address a stranger or fail at the creating
 * transaction, so they are dropped and reported instead. This is the only
 * reconciliation the draft needs — it decides nothing about policy, eligibility
 * or access level, which the server rechecks when it creates the Session.
 */
export function reconcileSessionAccessDraftForHome(input: Readonly<{
    access: SessionInitialAccessDraftV1 | null | undefined;
    previousServerId: string | null;
    nextServerId: string | null;
}>): SessionAccessDraftReconciliation {
    const access = input.access ?? null;
    const grants = access?.grants ?? [];
    if (input.previousServerId === input.nextServerId) {
        return { access, removedCount: 0, changed: false };
    }
    if (grants.length === 0) {
        return access === null ? UNCHANGED_EMPTY : { access, removedCount: 0, changed: false };
    }
    return { access: null, removedCount: grants.length, changed: true };
}
