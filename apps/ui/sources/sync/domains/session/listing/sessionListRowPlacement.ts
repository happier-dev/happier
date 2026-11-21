import { normalizeSessionViewerCompatibility } from '../readState/sessionViewer';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { resolveSessionListRenderableMeaningfulActivityAt } from './sessionListRenderableSorting';
import type { SessionListRowPlacementFacts } from './sessionListQuerySelection';
import type { SessionListRowPlacement } from './sessionListQueryController';
import { placeSessionListQueryRows } from './sessionListQueryInvalidation';
import { storage } from '@/sync/domains/state/storage';

/**
 * Reads the Home-published membership facts of one batch-read row. Null when the
 * row carries no current viewer projection (a released Home): that row cannot be
 * placed and its lists keep the conservative re-read.
 */
export function readSessionListRowPlacementFacts(
    row: SessionListRenderableSession,
): SessionListRowPlacementFacts | null {
    const viewer = normalizeSessionViewerCompatibility(row);
    if (viewer.kind !== 'current') return null;
    const reasons = viewer.viewer.relevance.reasons;
    return {
        archived: row.archivedAt != null,
        active: row.active === true,
        relevant: viewer.viewer.relevance.relevant,
        needsAttention: viewer.viewer.attention.needsAttention,
        ownerOrDirect: reasons.includes('owned_by_me') || reasons.includes('shared_directly_with_me'),
        pinned: reasons.includes('pinned_by_me'),
        sortKey: resolveSessionListRenderableMeaningfulActivityAt(row),
    };
}

/**
 * After the canonical batch owner applied these rows: place each in the ordinary
 * (owner-or-direct) corpus and in every mounted list of that Home by the
 * Home-published membership facts and the list sort key, without a list re-read.
 * Returns whether every requested row had current placement facts.
 */
export function placeSessionListRows(params: Readonly<{
    serverId: string;
    sessionIds: readonly string[];
    /** The ordinary frontier still has unread pages. */
    ordinaryHasMorePages: boolean;
}>): boolean {
    const state = storage.getState();
    const rows = state.sessionListRowsByServerId[params.serverId] ?? {};
    const placements: SessionListRowPlacement[] = [];
    const unplaceable: string[] = [];
    const sessionIds = new Set(params.sessionIds);
    for (const sessionId of sessionIds) {
        const row = rows[sessionId];
        const facts = row ? readSessionListRowPlacementFacts(row) : null;
        if (facts) placements.push({ sessionId, facts });
        else if (row) unplaceable.push(sessionId);
    }
    const readSortKey = (sessionId: string) => {
        const row = rows[sessionId];
        return row ? resolveSessionListRenderableMeaningfulActivityAt(row) : null;
    };
    const ordinary = state.ordinarySessionListMembershipByServerId[params.serverId] ?? [];
    const ordinaryIds = new Set(ordinary);
    let oldestLoaded = Number.POSITIVE_INFINITY;
    for (const sessionId of ordinary) oldestLoaded = Math.min(oldestLoaded, readSortKey(sessionId) ?? oldestLoaded);
    const ordinaryAdditions = placements.flatMap(({ sessionId, facts }) => facts.ownerOrDirect && !facts.archived
        && !ordinaryIds.has(sessionId) && (!params.ordinaryHasMorePages || facts.sortKey >= oldestLoaded)
        ? [rows[sessionId]!] : []);
    if (ordinaryAdditions.length > 0) state.mergeSessionListRowsForServerScope(params.serverId, ordinaryAdditions);
    placeSessionListQueryRows(params.serverId, placements, unplaceable, readSortKey);
    return placements.length === sessionIds.size;
}
