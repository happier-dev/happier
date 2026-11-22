import type { SessionListViewItem } from '@/sync/domains/state/storage';

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

function buildSessionKey(item: Extract<SessionListViewItem, { type: 'session' }>): string | null {
    const serverId = String(item.serverId ?? '').trim();
    const sessionId = String(item.session?.id ?? '').trim();
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

function appendSearchText(parts: string[], value: string | null | undefined): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length > 0) parts.push(trimmed);
}

function buildSessionSearchText(
    item: Extract<SessionListViewItem, { type: 'session' }>,
    sessionKey: string | null,
    searchableTextBySessionKey: Readonly<Record<string, string>>,
): string {
    const metadata = item.session.metadata;
    const parts: string[] = [];
    appendSearchText(parts, item.session.id);
    appendSearchText(parts, metadata?.name);
    appendSearchText(parts, metadata?.summaryText);
    appendSearchText(parts, metadata?.path);
    appendSearchText(parts, metadata?.host);
    appendSearchText(parts, metadata?.machineId);
    appendSearchText(parts, sessionKey ? searchableTextBySessionKey[sessionKey] : undefined);
    return parts.join('\n').toLocaleLowerCase();
}

function sessionMatchesSearch(
    item: Extract<SessionListViewItem, { type: 'session' }>,
    sessionKey: string | null,
    searchTokens: ReadonlyArray<string>,
    searchableTextBySessionKey: Readonly<Record<string, string>>,
    memoryMatchedSessionKeys: ReadonlySet<string> | null | undefined,
): boolean {
    if (searchTokens.length === 0) return true;
    if (sessionKey && memoryMatchedSessionKeys?.has(sessionKey)) return true;
    const haystack = buildSessionSearchText(item, sessionKey, searchableTextBySessionKey);
    if (!haystack) return false;
    return searchTokens.every((token) => haystack.includes(token));
}

export function hasActiveSessionListHeaderFilters(input: Pick<SessionListHeaderFilterInput, 'searchQuery' | 'selectedTags'> | null | undefined): boolean {
    if (!input) return false;
    return input.searchQuery.trim().length > 0 || input.selectedTags.length > 0;
}

function isPrimarySessionListHeader(item: Extract<SessionListViewItem, { type: 'header' }>): boolean {
    return isSessionListPrimaryHeaderKind(item.headerKind);
}

export function getSessionListHeaderControlsAnchorKey(item: Extract<SessionListViewItem, { type: 'header' }>): string {
    const groupKey = String(item.groupKey ?? '').trim();
    if (groupKey) return groupKey;
    return [
        String(item.headerKind ?? '').trim(),
        String(item.serverId ?? '').trim(),
        String(item.title ?? '').trim(),
    ].join('\u0001');
}

function ensureHeaderIncludedInOriginalOrder(
    items: ReadonlyArray<SessionListViewItem>,
    result: ReadonlyArray<SessionListViewItem>,
    header: Extract<SessionListViewItem, { type: 'header' }>,
): SessionListViewItem[] {
    if (result.includes(header)) return result as SessionListViewItem[];
    const resultSet = new Set(result);
    return items.filter((item) => item === header || resultSet.has(item));
}

export function filterSessionListItemsForHeaderControls(
    items: ReadonlyArray<SessionListViewItem>,
    input: SessionListHeaderFilterState,
): SessionListViewItem[] {
    if (!hasActiveSessionListHeaderFilters(input)) return items as SessionListViewItem[];

    const searchTokens = normalizeSearchTokens(input.searchQuery);
    const selectedTags = new Set(input.selectedTags);
    const result: SessionListViewItem[] = [];
    type Header = Extract<SessionListViewItem, { type: 'header' }>;
    const openHeaders: Array<{ header: Header; level: number; shown: boolean }> = [];
    const closeHeadersFrom = (level: number) => {
        while (openHeaders.length > 0 && openHeaders[openHeaders.length - 1]!.level >= level) {
            openHeaders.pop();
        }
    };
    let fallbackHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;
    let anchorHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;

    for (const item of items) {
        if (item.type === 'header') {
            if (isPrimarySessionListHeader(item)) {
                fallbackHeader ??= item;
                if (input.controlsAnchorKey && getSessionListHeaderControlsAnchorKey(item) === input.controlsAnchorKey) {
                    anchorHeader = item;
                }
                openHeaders.length = 0;
                openHeaders.push({ header: item, level: -1, shown: false });
            } else {
                const level = item.headerKind === 'folder' ? 1 + (item.depth ?? 0) : 0;
                closeHeadersFrom(level);
                openHeaders.push({ header: item, level, shown: false });
            }
            continue;
        }

        // Child folders are emitted before their parent's own sessions.
        closeHeadersFrom((item.groupKind === 'pinned' ? 0 : item.folderDepth ?? 0) + 1);
        const key = buildSessionKey(item);
        if (
            !sessionMatchesSelectedTags(key, selectedTags, input.sessionTags)
            || !sessionMatchesSearch(item, key, searchTokens, input.searchableTextBySessionKey, input.memoryMatchedSessionKeys)
        ) {
            continue;
        }

        for (const open of openHeaders) {
            if (open.shown) continue;
            open.shown = true;
            result.push(open.header);
        }
        result.push(item);
    }

    const preservedHeader = anchorHeader ?? fallbackHeader;
    if (!preservedHeader) return result;
    if (result.length === 0) return [preservedHeader];
    return ensureHeaderIncludedInOriginalOrder(items, result, preservedHeader);
}
