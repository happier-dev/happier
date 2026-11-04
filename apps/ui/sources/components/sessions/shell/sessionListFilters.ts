import { buildSessionListIndexEntityId, buildSessionListIndexNodeId, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { QualifiedTagAddress } from './search/sessionListViewFilters';

import { sessionTagKey } from './sessionTagUtils';
import { isSessionListPrimaryHeaderKind } from './sessionListPrimaryHeader';

export type SessionListHeaderFilterInput = Readonly<{
    searchQuery: string;
    /**
     * Qualified tag selections this surface must apply locally.
     *
     * Only the legacy owner/direct adapter populates it: when the Home answered
     * the strict query it already applied the tag predicate before pagination, so
     * a second local pass would re-decide membership from whatever rows happen to
     * be hydrated. Tags match by Home-local id, never by display label, so a tag
     * rename keeps the selection and two Homes' same-label tags stay distinct.
     */
    selectedTagIds: ReadonlyArray<QualifiedTagAddress>;
    /** Home-local tag ids assigned to each loaded Session, keyed by `sessionTagKey`. */
    sessionTagIdsBySessionKey?: Readonly<Record<string, readonly string[]>>;
    searchableTextBySessionKey: Readonly<Record<string, string>>;
    searchableTextByWorkflowRunKey?: Readonly<Record<string, string>>;
    primarySearchableTextBySessionKey?: Readonly<Record<string, string>>;
    memoryMatchedSessionKeys?: ReadonlySet<string>;
}>;

function normalizeSearchTokens(query: string): string[] {
    return query
        .trim()
        .toLocaleLowerCase()
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
}

function buildSessionKey(item: Exclude<SessionListIndexItem, { type: 'header' }>): string | null {
    if (item.type === 'workflow_run') return buildSessionListIndexNodeId(item);
    const serverId = String(item.serverId ?? '').trim();
    const sessionId = String(item.sessionId ?? '').trim();
    if (!serverId || !sessionId) return null;
    return sessionTagKey(serverId, sessionId);
}

function buildSelectedTagIdsByServerId(
    selectedTagIds: ReadonlyArray<QualifiedTagAddress>,
): Map<string, Set<string>> {
    const byServerId = new Map<string, Set<string>>();
    for (const tag of selectedTagIds) {
        const serverId = tag.serverId.trim();
        const tagId = tag.tagId.trim();
        if (!serverId || !tagId) continue;
        const existing = byServerId.get(serverId);
        if (existing) existing.add(tagId);
        else byServerId.set(serverId, new Set([tagId]));
    }
    return byServerId;
}

function sessionMatchesSelectedTags(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    sessionKey: string | null,
    selectedTagIdsByServerId: ReadonlyMap<string, ReadonlySet<string>>,
    sessionTagIdsBySessionKey: Readonly<Record<string, readonly string[]>>,
): boolean {
    if (selectedTagIdsByServerId.size === 0) return true;
    if (!sessionKey) return false;
    // The tag facet is active but this Home owns none of the selected tags, so it
    // cannot match — exactly how the structural query treats a Home with no value
    // in an active facet. Treating it as unrestricted would widen the corpus.
    const selectedForHome = selectedTagIdsByServerId.get(String(item.serverId ?? '').trim());
    if (!selectedForHome || selectedForHome.size === 0) return false;
    const assigned = sessionTagIdsBySessionKey[sessionKey] ?? [];
    return assigned.some((tagId) => selectedForHome.has(tagId));
}

export type SessionListSearchMatchClass = 'exact' | 'metadata' | 'transcript';

function resolveSessionSearchMatchClass(
    sessionKey: string | null,
    normalizedQuery: string,
    searchTokens: ReadonlyArray<string>,
    searchableTextBySessionKey: Readonly<Record<string, string>>,
    primarySearchableTextBySessionKey: Readonly<Record<string, string>> | null | undefined,
    memoryMatchedSessionKeys: ReadonlySet<string> | null | undefined,
): SessionListSearchMatchClass | null {
    if (searchTokens.length === 0) return 'metadata';
    if (!sessionKey) return null;
    const primaryLines = primarySearchableTextBySessionKey?.[sessionKey]
        ?.split('\n')
        .map((value) => value.trim().toLocaleLowerCase())
        .filter(Boolean) ?? [];
    if (primaryLines.includes(normalizedQuery)) return 'exact';
    const haystack = searchableTextBySessionKey[sessionKey]?.toLocaleLowerCase() ?? '';
    if (haystack && searchTokens.every((token) => haystack.includes(token))) return 'metadata';
    if (memoryMatchedSessionKeys?.has(sessionKey)) return 'transcript';
    return null;
}

function rankContiguousSessionRuns(
    items: SessionListIndexItem[],
    input: SessionListHeaderFilterInput,
    normalizedQuery: string,
    searchTokens: ReadonlyArray<string>,
): SessionListIndexItem[] {
    if (searchTokens.length === 0) return items;
    const providerRank = new Map<string, number>();
    let nextProviderRank = 0;
    for (const sessionKey of input.memoryMatchedSessionKeys ?? []) {
        providerRank.set(sessionKey, nextProviderRank);
        nextProviderRank += 1;
    }
    const bandRank: Record<SessionListSearchMatchClass, number> = {
        exact: 0,
        metadata: 1,
        transcript: 2,
    };
    const next = items.slice();
    let runStart = 0;
    while (runStart < next.length) {
        if (next[runStart]?.type !== 'session') {
            runStart += 1;
            continue;
        }
        let runEnd = runStart + 1;
        while (runEnd < next.length && next[runEnd]?.type === 'session') runEnd += 1;
        // Relevance ranks ordinary peers, never a child independently of its tree.
        if (next.slice(runStart, runEnd).some((item) => item.type !== 'header' && (item.reportsDepth ?? 0) > 0)) {
            runStart = runEnd;
            continue;
        }
        const ranked = next.slice(runStart, runEnd).map((item, index) => {
            const session = item as Extract<SessionListIndexItem, { type: 'session' }>;
            const sessionKey = buildSessionKey(session);
            const matchClass = resolveSessionSearchMatchClass(
                sessionKey,
                normalizedQuery,
                searchTokens,
                input.searchableTextBySessionKey,
                input.primarySearchableTextBySessionKey,
                input.memoryMatchedSessionKeys,
            ) ?? 'transcript';
            return {
                item,
                index,
                band: bandRank[matchClass],
                provider: matchClass === 'transcript' && sessionKey
                    ? providerRank.get(sessionKey) ?? Number.MAX_SAFE_INTEGER
                    : index,
            };
        }).sort((left, right) => (
            left.band - right.band
            || left.provider - right.provider
            || left.index - right.index
        ));
        for (let index = 0; index < ranked.length; index += 1) {
            next[runStart + index] = ranked[index]!.item;
        }
        runStart = runEnd;
    }
    return next;
}

/**
 * Nesting level of a group header, used to decide which pending headers a newly
 * opened group closes. Containers nest as primary section > server > project/date >
 * folder subtree, and a folder's own depth extends that chain.
 *
 * A primary section header (Needs attention, Working, Pinned, Active, Inactive,
 * Sessions) contains every container that follows it until the next primary header,
 * so it sits strictly above the server level and no nested group can close it.
 */
function resolveSessionListHeaderNestingDepth(
    header: Extract<SessionListIndexItem, { type: 'header' }>,
): number {
    if (isSessionListPrimaryHeaderKind(header.headerKind)) return -1;
    if (header.headerKind === 'server') return 0;
    if (header.headerKind === 'folder') {
        const folderDepth = typeof header.folderDepth === 'number' && Number.isFinite(header.folderDepth)
            ? Math.max(0, Math.trunc(header.folderDepth))
            : 0;
        return 2 + folderDepth;
    }
    return 1;
}

export function hasActiveSessionListHeaderFilters(input: Pick<SessionListHeaderFilterInput, 'searchQuery' | 'selectedTagIds'> | null | undefined): boolean {
    if (!input) return false;
    return input.searchQuery.trim().length > 0 || input.selectedTagIds.length > 0;
}

export type SessionListHeaderFilterProjection = Readonly<{
    items: SessionListIndexItem[];
    matchedEntityIds: ReadonlySet<string>;
}>;

function buildSessionListHeaderFilterProjection(items: SessionListIndexItem[], matchedEntityIds?: ReadonlySet<string>): SessionListHeaderFilterProjection {
    return { items, matchedEntityIds: matchedEntityIds ?? new Set(items.flatMap(item => item.type === 'header' ? [] : [buildSessionListIndexEntityId(item)])) };
}

export function projectSessionListItemsForHeaderControls(
    items: ReadonlyArray<SessionListIndexItem>,
    input: SessionListHeaderFilterInput,
): SessionListHeaderFilterProjection {
    if (!hasActiveSessionListHeaderFilters(input)) return buildSessionListHeaderFilterProjection(items as SessionListIndexItem[]);

    const searchTokens = normalizeSearchTokens(input.searchQuery);
    const normalizedQuery = input.searchQuery.trim().toLocaleLowerCase();
    const selectedTagIdsByServerId = buildSelectedTagIdsByServerId(input.selectedTagIds);
    const sessionTagIdsBySessionKey = input.sessionTagIdsBySessionKey ?? {};
    const result: SessionListIndexItem[] = [];
    let pendingHeaders: Extract<SessionListIndexItem, { type: 'header' }>[] = [];

    // Keep the exact ancestor chain of a search hit, so a matching step never becomes a root.
    const selected = new Set<SessionListIndexItem>();
    const matchedEntityIds = new Set<string>();
    const ancestors: Exclude<SessionListIndexItem, { type: 'header' }>[] = [];
    for (const item of items) {
        if (item.type === 'header') { ancestors.length = 0; continue; }
        const depth = item.reportsDepth ?? 0;
        while (ancestors.length > 0 && (ancestors[ancestors.length - 1]!.reportsDepth ?? 0) >= depth) ancestors.pop();
        const key = buildSessionKey(item);
        const tagsMatch = item.type === 'session'
            ? sessionMatchesSelectedTags(item, key, selectedTagIdsByServerId, sessionTagIdsBySessionKey)
            : selectedTagIdsByServerId.size === 0;
        if (tagsMatch && resolveSessionSearchMatchClass(key, normalizedQuery, searchTokens,
            item.type === 'workflow_run' ? input.searchableTextByWorkflowRunKey ?? {} : input.searchableTextBySessionKey,
            item.type === 'workflow_run' ? undefined : input.primarySearchableTextBySessionKey,
            item.type === 'workflow_run' ? undefined : input.memoryMatchedSessionKeys) !== null) {
            matchedEntityIds.add(buildSessionListIndexEntityId(item));
            selected.add(item);
            ancestors.forEach((ancestor) => selected.add(ancestor));
        }
        ancestors.push(item);
    }

    for (const item of items) {
        if (item.type === 'header') {
            if (isSessionListPrimaryHeaderKind(item.headerKind)) {
                pendingHeaders = [item];
                continue;
            }
            // Only strict ancestors of the new header can still gain a visible
            // descendant. Anything at the same or deeper level has been closed by
            // this header, so keeping it would emit a childless group — an empty
            // `Today` above a `Yesterday` that matched, or a stale folder above its
            // sibling.
            const depth = resolveSessionListHeaderNestingDepth(item);
            while (
                pendingHeaders.length > 0
                && resolveSessionListHeaderNestingDepth(pendingHeaders[pendingHeaders.length - 1]!) >= depth
            ) {
                pendingHeaders.pop();
            }
            pendingHeaders.push(item);
            continue;
        }

        if (!selected.has(item)) continue;

        if (pendingHeaders.length > 0) {
            result.push(...pendingHeaders);
            pendingHeaders = [];
        }
        result.push(item);
    }

    // No header is preserved for an empty result: the stable search chrome owns the
    // field's lifetime, and the list-level no-results message reports the outcome.
    return buildSessionListHeaderFilterProjection(rankContiguousSessionRuns(result, input, normalizedQuery, searchTokens), matchedEntityIds);
}

export function filterSessionListItemsForHeaderControls(
    items: ReadonlyArray<SessionListIndexItem>,
    input: SessionListHeaderFilterInput,
): SessionListIndexItem[] {
    return projectSessionListItemsForHeaderControls(items, input).items;
}
