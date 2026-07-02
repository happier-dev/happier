import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { sessionTagKey } from './sessionTagUtils';
import { isSessionListPrimaryHeaderKind } from './sessionListPrimaryHeader';

export type SessionListHeaderFilterInput = Readonly<{
    searchQuery: string;
    selectedTags: ReadonlyArray<string>;
    searchableTextBySessionKey: Readonly<Record<string, string>>;
    memoryMatchedSessionKeys?: ReadonlySet<string>;
    controlsAnchorKey?: string | null;
}>;

export type SessionListHeaderFilterState = SessionListHeaderFilterInput & Readonly<{
    sessionTags: Readonly<Record<string, readonly string[]>>;
}>;

function normalizeSearchTokens(query: string): string[] {
    return query
        .trim()
        .toLocaleLowerCase()
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
}

function buildSessionKey(item: Extract<SessionListIndexItem, { type: 'session' }>): string | null {
    const serverId = String(item.serverId ?? '').trim();
    const sessionId = String(item.sessionId ?? '').trim();
    if (!serverId || !sessionId) return null;
    return sessionTagKey(serverId, sessionId);
}

function sessionMatchesSelectedTags(
    sessionKey: string | null,
    selectedTags: ReadonlySet<string>,
    sessionTags: Readonly<Record<string, readonly string[]>>,
): boolean {
    if (selectedTags.size === 0) return true;
    if (!sessionKey) return false;
    const tags = sessionTags[sessionKey] ?? [];
    return tags.some((tag) => selectedTags.has(tag));
}

function sessionMatchesSearch(
    sessionKey: string | null,
    searchTokens: ReadonlyArray<string>,
    searchableTextBySessionKey: Readonly<Record<string, string>>,
    memoryMatchedSessionKeys: ReadonlySet<string> | null | undefined,
): boolean {
    if (searchTokens.length === 0) return true;
    if (!sessionKey) return false;
    if (memoryMatchedSessionKeys?.has(sessionKey)) return true;
    const haystack = searchableTextBySessionKey[sessionKey]?.toLocaleLowerCase() ?? '';
    if (!haystack) return false;
    return searchTokens.every((token) => haystack.includes(token));
}

export function hasActiveSessionListHeaderFilters(input: Pick<SessionListHeaderFilterInput, 'searchQuery' | 'selectedTags'> | null | undefined): boolean {
    if (!input) return false;
    return input.searchQuery.trim().length > 0 || input.selectedTags.length > 0;
}

function isPrimarySessionListHeader(item: Extract<SessionListIndexItem, { type: 'header' }>): boolean {
    return isSessionListPrimaryHeaderKind(item.headerKind);
}

export function getSessionListHeaderControlsAnchorKey(item: Extract<SessionListIndexItem, { type: 'header' }>): string {
    const groupKey = String(item.groupKey ?? '').trim();
    if (groupKey) return groupKey;
    return [
        String(item.headerKind ?? '').trim(),
        String(item.serverId ?? '').trim(),
        String(item.title ?? '').trim(),
    ].join('\u0001');
}

function ensureHeaderIncludedInOriginalOrder(
    items: ReadonlyArray<SessionListIndexItem>,
    result: ReadonlyArray<SessionListIndexItem>,
    header: Extract<SessionListIndexItem, { type: 'header' }>,
): SessionListIndexItem[] {
    if (result.includes(header)) return result as SessionListIndexItem[];
    const resultSet = new Set(result);
    return items.filter((item) => item === header || resultSet.has(item));
}

export function filterSessionListItemsForHeaderControls(
    items: ReadonlyArray<SessionListIndexItem>,
    input: SessionListHeaderFilterState,
): SessionListIndexItem[] {
    if (!hasActiveSessionListHeaderFilters(input)) return items as SessionListIndexItem[];

    const searchTokens = normalizeSearchTokens(input.searchQuery);
    const selectedTags = new Set(input.selectedTags);
    const result: SessionListIndexItem[] = [];
    let pendingHeaders: Extract<SessionListIndexItem, { type: 'header' }>[] = [];
    let fallbackHeader: Extract<SessionListIndexItem, { type: 'header' }> | null = null;
    let anchorHeader: Extract<SessionListIndexItem, { type: 'header' }> | null = null;

    for (const item of items) {
        if (item.type === 'header') {
            if (isPrimarySessionListHeader(item)) {
                fallbackHeader ??= item;
                if (input.controlsAnchorKey && getSessionListHeaderControlsAnchorKey(item) === input.controlsAnchorKey) {
                    anchorHeader = item;
                }
                pendingHeaders = [item];
            } else {
                pendingHeaders.push(item);
            }
            continue;
        }

        const key = buildSessionKey(item);
        if (
            !sessionMatchesSelectedTags(key, selectedTags, input.sessionTags)
            || !sessionMatchesSearch(key, searchTokens, input.searchableTextBySessionKey, input.memoryMatchedSessionKeys)
        ) {
            continue;
        }

        if (pendingHeaders.length > 0) {
            result.push(...pendingHeaders);
            pendingHeaders = [];
        }
        result.push(item);
    }

    const preservedHeader = anchorHeader ?? fallbackHeader;
    if (!preservedHeader) return result;
    if (result.length === 0) return [preservedHeader];
    return ensureHeaderIncludedInOriginalOrder(items, result, preservedHeader);
}
