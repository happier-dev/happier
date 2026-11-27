import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';

/** GET pages cannot silently broaden a structurally selected query. */
export function canSessionListOrdinaryPageAnswerQuery(query: SessionListQueryV1): boolean {
    return !hasSessionListRowSelection(query) && query.scope === 'my_work';
}

function hasSessionListRowSelection(query: SessionListQueryV1): boolean {
    return query.membership !== undefined
        || query.audiences.include.length + query.audiences.exclude.length > 0
        || query.underSessionId !== undefined
        || query.coordinator !== undefined
        || query.tagIds.include.length + query.tagIds.exclude.length > 0
        || Boolean(query.folderIds?.length)
        || Boolean(query.projectKeys?.include.length || query.projectKeys?.exclude.length)
        || query.attention !== 'any';
}

/**
 * Which membership inputs a batch of row-level Session writes can move. The change
 * planner derives it from the row-only hints; organization, access and relation
 * edits never arrive as row-level writes, so they are absent here by construction.
 */
export type SessionListRowMembershipFacets = Readonly<{
    /** Pending requests, readiness, transcript and read cursor feed personal attention. */
    attention: boolean;
    /** Metadata carries the Project key and Session relations. */
    metadata: boolean;
    /** Runtime activity and turn status decide published liveness. */
    activity: boolean;
}>;

export function canRowWriteChangeSessionListMembership(
    query: SessionListQueryV1,
    facets?: SessionListRowMembershipFacets,
): boolean {
    if (facets) return canRowFacetsChangeSessionListMembership(query, facets);
    if (hasSessionListRowSelection(query)) return true;
    if (query.scope === 'my_work') return false;
    // Exact row refresh owns content; structural and attention membership still
    // need replacement reads when the changed row can enter or leave the corpus.
    return query.scope !== 'all_accessible' || !query.includeInactive || query.includeAttention === true;
}

function canRowFacetsChangeSessionListMembership(
    query: SessionListQueryV1,
    facets: SessionListRowMembershipFacets,
): boolean {
    const attention = facets.attention
        && (query.attention !== 'any' || (query.scope !== 'my_work' && query.includeAttention === true));
    const metadata = facets.metadata && (Boolean(query.projectKeys?.include.length || query.projectKeys?.exclude.length)
        || query.underSessionId !== undefined || query.coordinator !== undefined);
    // Hidden-inactive corpora admit inactive rows only through attention.
    const liveness = query.scope !== 'my_work' && !query.includeInactive && (facets.activity || facets.attention);
    // Saved membership and the narrower scopes keep their conservative re-read.
    const opaque = query.membership !== undefined
        || (query.scope !== 'my_work' && query.scope !== 'all_accessible');
    return attention || metadata || liveness || opaque;
}

/**
 * Row facts the Home publishes on the exact batch-read row, for the viewer. The
 * Home computes `relevant` and `needsAttention` with the same owners that select
 * `my_work` and `needs_my_attention` (server parity:
 * `personal/listMembershipParity.sqlite.integration.spec.ts`); the client never
 * re-derives either rule.
 */
export type SessionListRowPlacementFacts = Readonly<{
    archived: boolean;
    /** Published liveness, the same fact hide-inactive selects. */
    active: boolean;
    /** `viewer.relevance.relevant`: the Home's `my_work` decision. */
    relevant: boolean;
    /** `viewer.attention.needsAttention`: the Home's `needs_my_attention` decision. */
    needsAttention: boolean;
    /** Owner-or-direct reader: the ordinary GET corpus. */
    ownerOrDirect: boolean;
    /** `pinned_by_me`: an active-storage first page carries every pinned member. */
    pinned: boolean;
    /** List sort key (`meaningfulActivityAt`, else `createdAt`). */
    sortKey: number;
}>;

/** Whether every selector of this query is decided by the published row facts. */
export function isSessionListQueryRowPlaceable(query: SessionListQueryV1): boolean {
    return (query.membership === undefined || isSessionListMembershipFilterRowDecided(query.membership.filter))
        && query.audiences.include.length + query.audiences.exclude.length === 0
        && query.tagIds.include.length + query.tagIds.exclude.length === 0
        && !query.folderIds?.length
        && !query.projectKeys?.include.length && !query.projectKeys?.exclude.length
        && query.underSessionId === undefined
        && query.coordinator === undefined
        && (query.scope === 'my_work' || query.scope === 'all_accessible');
}

/** The query's membership decision for one readable row; null when the row facts cannot decide it. */
export function resolveSessionListQueryRowMembership(
    query: SessionListQueryV1,
    facts: SessionListRowPlacementFacts,
): boolean | null {
    if (!isSessionListQueryRowPlaceable(query)) return null;
    if ((query.storage === 'archived') !== facts.archived) return false;
    if (query.attention === 'needs_my_attention' && !facts.needsAttention) return false;
    const inScope = query.scope === 'all_accessible' || facts.relevant;
    // Hidden-inactive corpora admit an inactive row only through attention.
    const live = query.includeInactive || facts.active || facts.needsAttention;
    if (!inScope || !live || !query.membership) return inScope && live;
    // A Space answers `manual tag OR smart filter` inside the outer lens. A row write never
    // moves tag assignments, so a filter match decides membership; a miss leaves the
    // manual branch to the Home, whose tag assignments the batch-read row does not carry.
    const { membership } = query;
    if (membership.mode === 'filter_or_manual' && membership.filter
        && (membership.filter.scope === 'all_accessible' || facts.relevant)
        && (membership.filter.attention !== 'needs_my_attention' || facts.needsAttention)) return true;
    return membership.tagIds.length === 0 ? false : null;
}

/** A Space's smart filter that the row's published facts decide (no organization or relation selector). */
function isSessionListMembershipFilterRowDecided(filter: NonNullable<SessionListQueryV1['membership']>['filter']): boolean {
    return filter === undefined || (filter.audiences.include.length + filter.audiences.exclude.length === 0
        && filter.tagIds.include.length + filter.tagIds.exclude.length === 0
        && !filter.folderIds?.length
        && !filter.projectKeys?.include.length && !filter.projectKeys?.exclude.length
        && filter.underSessionId === undefined
        && filter.coordinator === undefined
        && (filter.scope === 'my_work' || filter.scope === 'all_accessible'));
}
