import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';
import { isArtifactOnlyHomeAccountChange, subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionListRowMembershipFacets } from './sessionListQuerySelection';
import type { SessionListRowPlacement } from './sessionListQueryController';

type SessionListQueryInvalidationTarget = Readonly<{
    /** `'structural'` re-reads only a corpus whose server-side selection a row write can move. */
    invalidate(scope?: 'structural' | 'recover', rowFacets?: SessionListRowMembershipFacets): Promise<void>;
    retire(sessionId: string): void;
    place?(rows: readonly SessionListRowPlacement[], readSortKey: (sessionId: string) => number | null): boolean;
}>;

type SessionListQueryInvalidationReader = () => ReadonlyMap<string, SessionListQueryInvalidationTarget>;
const mountedSessionListQueryReaders = new Set<SessionListQueryInvalidationReader>();

const readEpochByServerId = new Map<string, number>();
const invalidationsCounted = new WeakSet<object>();

function advanceReadEpoch(serverId: string): void {
    readEpochByServerId.set(serverId, (readEpochByServerId.get(serverId) ?? 0) + 1);
}

/**
 * Which generation of a Home's corpus a page read belongs to. Every invalidation of the Home starts a
 * new one, so a read already on the wire when a Home changed cannot answer a read asked for afterwards.
 */
export function readSessionListQueryReadEpoch(serverId: string): number {
    return readEpochByServerId.get(serverId) ?? 0;
}

/**
 * Invalidates the mounted filtered-list controller for one exact Home.
 *
 * This is the imperative leaf of the existing query-invalidation owner. It is
 * used when a local wall-clock boundary changes list membership without a Home
 * Account-change event (for example a persisted reminder becoming due).
 */
export function invalidateSessionListQueryHome(serverId: string): Promise<void> {
    advanceReadEpoch(serverId);
    const pending: Array<Promise<void>> = [];
    for (const readControllers of mountedSessionListQueryReaders) {
        const target = readControllers().get(serverId);
        if (target) pending.push(target.invalidate());
    }
    return Promise.all(pending).then(() => undefined);
}

/**
 * Retires one committed-deleted/revoked Session from the mounted filtered-list
 * membership of exactly that Home (every Home when the retirement addressed none),
 * leaving a same-id Session on another Home untouched.
 */
export function retireSessionListQueryAddress(serverId: string | null, sessionId: string): void {
    for (const readControllers of mountedSessionListQueryReaders) {
        for (const [controllerServerId, target] of readControllers()) {
            if (serverId && !areServerProfileIdentifiersEquivalent(controllerServerId, serverId)) continue;
            target.retire(sessionId);
        }
    }
}

/**
 * Places freshly batch-read rows into every mounted list of exactly that Home.
 * Rows whose viewer facts are unavailable cannot be placed, so their Home's
 * lists keep the conservative re-read.
 */
export function placeSessionListQueryRows(
    serverId: string,
    rows: readonly SessionListRowPlacement[],
    unplaceableSessionIds: readonly string[],
    readSortKey: (sessionId: string) => number | null,
): void {
    if (rows.length === 0 && unplaceableSessionIds.length === 0) return;
    for (const readControllers of mountedSessionListQueryReaders) {
        const target = readControllers().get(serverId);
        if (!target) continue;
        if (rows.length > 0) target.place?.(rows, readSortKey);
        if (unplaceableSessionIds.length > 0) void target.invalidate();
    }
}

/**
 * Exact focused-Home catch-up identifies `self` for Account settings, profile,
 * security and encryption changes. The incumbent planner supplies whether the
 * concrete change can alter qualified list membership; this consumer must not
 * guess from the shared `self` identifier.
 *
 * A socket-only concurrent-Home wake has no entity identities, so it stays
 * conservative. Do not infer a domain cause from content or ciphertext here.
 */
export function resolveSessionListQueryInvalidationForAccountChange(
    event: HomeAccountChangeEvent,
): 'none' | 'structural' | 'recover' | 'all' {
    // A reconnect whose publisher starts this Home's changes catch-up carries no Session change: that
    // catch-up delivers what changed while away (rows, structure, or a gap's full refresh), so lists only
    // recover a lost answer. A Home without that catch-up (a secondary transport) re-reads below.
    if (event.source === 'connected' && event.changesCatchUp === true
        && event.sessionListQueryAffects === undefined && event.entityIds === undefined) return 'recover';
    if (event.sessionListQueryAffects !== undefined) {
        if (event.sessionListQueryAffects === 'structural') return 'structural';
        return event.sessionListQueryAffects ? 'all' : 'none';
    }
    // Committed Artifact receipts also wake Account readers, but cannot move
    // a Session corpus. Mixed or unqualified wakes keep the conservative path.
    if (isArtifactOnlyHomeAccountChange(event)) return 'none';
    return event.entityIds === undefined
        || event.entityIds.some((entityId) => entityId !== 'self')
        ? 'all'
        : 'none';
}

/**
 * Connect mounted filtered-list controllers to the incumbent Account-change
 * owner. This adapter requests one exact-Home refresh; it does not interpret
 * membership or create another event stream.
 */
export function subscribeSessionListQueryHomeInvalidation(
    readControllers: SessionListQueryInvalidationReader,
): () => void {
    mountedSessionListQueryReaders.add(readControllers);
    const unsubscribeAccountChanges = subscribeHomeAccountChange((event) => {
        const invalidation = resolveSessionListQueryInvalidationForAccountChange(event);
        if (invalidation === 'none') return;
        const target = readControllers().get(event.serverId);
        if (invalidation === 'recover') {
            if (target) void target.invalidate('recover');
            return;
        }
        // Each mounted corpus hears the same event; the Home's reads start a new generation once.
        if (!invalidationsCounted.has(event)) {
            invalidationsCounted.add(event);
            advanceReadEpoch(event.serverId);
        }
        if (!target) return;
        const rowFacets = event.sessionListRowFacets;
        void (invalidation !== 'structural' ? target.invalidate()
            : rowFacets ? target.invalidate('structural', rowFacets) : target.invalidate('structural'));
        // A primary reconnect reaches the controllers, whose `'recover'` re-reads only a corpus the outage left
        // without a current answer (the classifier above); ready corpora wait for the catch-up's exact wakes.
    }, { reconnect: 'refresh' });
    return () => {
        unsubscribeAccountChanges();
        mountedSessionListQueryReaders.delete(readControllers);
    };
}
