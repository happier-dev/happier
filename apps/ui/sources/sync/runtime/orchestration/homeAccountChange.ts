import { HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import {
    subscribeHomeCredentialMutations,
    type HomeCredentialMutationEvent,
} from '@/auth/storage/tokenStorage';

/**
 * Observers of the content-free Account-change wake this owner already receives
 * on each Home socket.
 *
 * This is an observation seam over the existing wake, not a second
 * synchronization system: it opens no socket, starts no cursor, replays no
 * domain events and promises no delivery or ordering beyond the wake itself.
 * Account-scoped projections that are fully reconstructible (Home governance,
 * Teams, Follow preferences) use it to invalidate the exact Home and refetch.
 */
export type HomeAccountChangeEvent = Readonly<{
    serverId: string;
    /** Exact only for a consumed focused-Home change page; absent wakes remain conservative. */
    entityIds?: readonly string[];
    /**
     * Detailed focused-Home catch-up may publish the incumbent change planner's
     * exact Session-list decision. Socket-only concurrent-Home wakes omit it and
     * remain conservative. `'structural'` means only row-level Session writes: a
     * corpus the ordinary list can answer is unaffected, a structural filter may move.
     */
    sessionListQueryAffects?: boolean | 'structural';
}>;

type HomeAccountChangeDetails = Readonly<{
    sessionListQueryAffects?: boolean | 'structural';
}>;

/** Focused changes that can alter Home administration eligibility or rows. */
export function isHomeAdministrationAccountChange(event: HomeAccountChangeEvent): boolean {
    return event.entityIds === undefined
        || event.entityIds.includes(HOME_GOVERNANCE_ACCOUNT_CHANGE_ENTITY_ID_V1)
        || event.entityIds.includes('self');
}

type HomeAccountChangeObserver = (event: HomeAccountChangeEvent) => void;

const homeAccountChangeObservers = new Set<HomeAccountChangeObserver>();

type HomeCredentialChangeObserver = (event: HomeCredentialMutationEvent) => void;
const homeCredentialChangeObservers = new Set<HomeCredentialChangeObserver>();
let unsubscribeHomeCredentialMutations: (() => void) | null = null;

function releaseHomeCredentialMutationObserverIfIdle(): void {
    if (homeCredentialChangeObservers.size > 0) return;
    unsubscribeHomeCredentialMutations?.();
    unsubscribeHomeCredentialMutations = null;
}

/**
 * One refcounted credential-mutation fanout for reconstructible Home projections. Domains decide
 * whether to retain signed-out rows or clear replaced-Account rows; none installs its own watcher.
 */
export function subscribeHomeCredentialChange(observer: HomeCredentialChangeObserver): () => void {
    homeCredentialChangeObservers.add(observer);
    if (!unsubscribeHomeCredentialMutations) {
        unsubscribeHomeCredentialMutations = subscribeHomeCredentialMutations((event) => {
            for (const current of [...homeCredentialChangeObservers]) {
                try {
                    current(event);
                } catch {
                    // One projection cannot suppress credential retirement for its siblings.
                }
            }
        });
    }
    return () => {
        homeCredentialChangeObservers.delete(observer);
        releaseHomeCredentialMutationObserverIfIdle();
    };
}

export type { HomeCredentialMutationEvent };

export function subscribeHomeAccountChange(
    observer: HomeAccountChangeObserver,
): () => void {
    homeAccountChangeObservers.add(observer);
    return () => {
        homeAccountChangeObservers.delete(observer);
    };
}

export function publishHomeAccountChange(
    serverId: string,
    entityIds?: readonly string[],
    details?: HomeAccountChangeDetails,
): void {
    if (homeAccountChangeObservers.size === 0) return;
    const event = Object.freeze({
        serverId,
        ...(entityIds ? { entityIds: Object.freeze([...new Set(entityIds)]) } : {}),
        ...(details?.sessionListQueryAffects !== undefined
            ? { sessionListQueryAffects: details.sessionListQueryAffects }
            : {}),
    });
    for (const observer of [...homeAccountChangeObservers]) {
        try {
            observer(event);
        } catch {
            // One observer cannot suppress the wake for its siblings or for
            // this owner's own session-cache refresh.
        }
    }
}
