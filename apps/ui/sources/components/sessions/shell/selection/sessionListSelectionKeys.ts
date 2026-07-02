import { buildServerScopedSessionKey, type VisibleSessionNavigationEntry } from '@/keyboard/sessions';

export type SessionListSelectionKeyInput = Readonly<{
    sessionId: string;
    serverId?: string | null;
}>;

export type SessionListSelectionScopeKeyInput = Readonly<{
    storageKind?: string | null;
    activeServerId?: string | null;
    focusedFolderId?: string | null;
    searchQuery?: string | null;
    selectedTags?: readonly string[] | null;
    hideInactiveSessions?: boolean | null;
}>;

function normalizeScopePart(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeSearchQuery(value: unknown): string {
    return normalizeScopePart(value).toLocaleLowerCase();
}

function normalizeSelectedTags(tags: readonly string[] | null | undefined): string[] {
    return Array.from(new Set((tags ?? [])
        .map((tag) => normalizeScopePart(tag))
        .filter(Boolean)))
        .sort((left, right) => left.localeCompare(right));
}

export function buildSessionListSelectionKey(input: SessionListSelectionKeyInput): string {
    return buildServerScopedSessionKey(input.sessionId, input.serverId);
}

export function readSessionListSelectionKeysFromVisibleEntries(
    entries: readonly VisibleSessionNavigationEntry[],
): string[] {
    return entries.map((entry) => entry.sessionKey);
}

export function buildSessionListSelectionScopeKey(input: SessionListSelectionScopeKeyInput): string {
    return JSON.stringify({
        storageKind: normalizeScopePart(input.storageKind) || 'all',
        activeServerId: normalizeScopePart(input.activeServerId) || null,
        focusedFolderId: normalizeScopePart(input.focusedFolderId) || null,
        searchQuery: normalizeSearchQuery(input.searchQuery),
        selectedTags: normalizeSelectedTags(input.selectedTags),
        hideInactiveSessions: input.hideInactiveSessions === true,
    });
}
