import type { SessionListViewItem } from '@/sync/domains/state/storage';

import { sessionTagKey } from './sessionTagUtils';
import { isSessionListPrimaryHeaderKind } from './sessionListPrimaryHeader';

export type SessionListHeaderFilterInput = Readonly<{
    searchQuery: string;
    selectedTags: ReadonlyArray<string>;
    searchableTextBySessionKey: Readonly<Record<string, string>>;
    memoryMatchedSessionKeys?: ReadonlySet<string>;
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

// Main sections (and the server headings above them) always stay visible while filtering, even when empty.
function isAlwaysVisibleSessionListHeader(item: Extract<SessionListViewItem, { type: 'header' }>): boolean {
    return item.headerKind === 'server' || isSessionListPrimaryHeaderKind(item.headerKind);
}

// Nesting level of a sub-heading: project/date/shared headings are 0, folders sit below them by depth.
function resolveSubHeaderLevel(item: Extract<SessionListViewItem, { type: 'header' }>): number {
    return item.headerKind === 'folder' ? 1 + (item.depth ?? 0) : 0;
}

// Level of the sub-heading a session belongs to. Folder sessions carry folderDepth = folder depth + 1.
function resolveSessionParentLevel(item: Extract<SessionListViewItem, { type: 'session' }>): number {
    return typeof item.folderDepth === 'number' && item.folderDepth > 0 ? item.folderDepth : 0;
}

type OpenSubHeader = {
    header: Extract<SessionListViewItem, { type: 'header' }>;
    level: number;
    shown: boolean;
};

export function filterSessionListItemsForHeaderControls(
    items: ReadonlyArray<SessionListViewItem>,
    input: SessionListHeaderFilterState,
): SessionListViewItem[] {
    if (!hasActiveSessionListHeaderFilters(input)) return items as SessionListViewItem[];

    const searchTokens = normalizeSearchTokens(input.searchQuery);
    const selectedTags = new Set(input.selectedTags);
    const result: SessionListViewItem[] = [];
    // Sub-headings on the path to the current row; each is shown only once a session beneath it matches.
    const openSubHeaders: OpenSubHeader[] = [];
    const closeSubHeadersFrom = (level: number) => {
        while (openSubHeaders.length > 0 && openSubHeaders[openSubHeaders.length - 1]!.level >= level) {
            openSubHeaders.pop();
        }
    };

    for (const item of items) {
        if (item.type === 'header') {
            if (isAlwaysVisibleSessionListHeader(item)) {
                openSubHeaders.length = 0;
                result.push(item);
            } else {
                const level = resolveSubHeaderLevel(item);
                closeSubHeadersFrom(level);
                openSubHeaders.push({ header: item, level, shown: false });
            }
            continue;
        }

        // A session closes any deeper folder headings listed before it (child folders precede parent sessions).
        closeSubHeadersFrom(resolveSessionParentLevel(item) + 1);

        const key = buildSessionKey(item);
        if (
            !sessionMatchesSelectedTags(key, selectedTags, input.sessionTags)
            || !sessionMatchesSearch(item, key, searchTokens, input.searchableTextBySessionKey, input.memoryMatchedSessionKeys)
        ) {
            continue;
        }

        for (const open of openSubHeaders) {
            if (open.shown) continue;
            open.shown = true;
            result.push(open.header);
        }
        result.push(item);
    }

    return result;
}
