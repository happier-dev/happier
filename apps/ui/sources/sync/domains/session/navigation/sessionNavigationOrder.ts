/**
 * Canonical owner for session-navigation order: how the visible session list and
 * the MRU order are turned into navigable entries, and how a direction step
 * resolves against them.
 *
 * Consumers (keyboard shortcuts, the session list shell, lateral swipe) read this
 * module; none of them re-implement ordering locally. Pure module: no React, no
 * `sync/store/**` dependency.
 *
 * This lived in `@/keyboard/sessions` while the keyboard was its only consumer. It moved here
 * when lateral swipe became a second consumer: ordering is a session-domain concept, and leaving
 * it under `keyboard/` would have made every non-keyboard surface either import from the keyboard
 * layer or re-derive the order. `keyboard/sessions` keeps only shortcut-availability policy.
 */

export type SessionNavigationDirection = 'previous' | 'next';

export type VisibleSessionNavigationEntry = Readonly<{
    index: number;
    sessionId: string;
    sessionKey: string;
    serverId?: string;
}>;

/**
 * Structural shape of a rendered session-list row: exactly the fields ordering needs,
 * so `SessionListIndexItem[]` — what the list actually renders — is passable as-is and
 * the surfaces that hold session records instead (archived, recent) normalize to it at
 * their own boundary rather than teaching this module a second row shape.
 */
export type SessionListLikeItem = Readonly<{
    type: string;
    sessionId?: unknown;
    serverId?: unknown;
}>;

const DEFAULT_SESSION_MRU_MAX_ENTRIES = 50;

function normalizeSessionKeyPart(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function parseServerScopedSessionKey(sessionKey: string): Pick<VisibleSessionNavigationEntry, 'sessionId' | 'sessionKey' | 'serverId'> {
    const normalizedKey = normalizeSessionKeyPart(sessionKey);
    const separatorIndex = normalizedKey.indexOf(':');
    if (separatorIndex <= 0) {
        return {
            sessionId: normalizedKey,
            sessionKey: normalizedKey,
        };
    }

    const serverId = normalizedKey.slice(0, separatorIndex).trim();
    const sessionId = normalizedKey.slice(separatorIndex + 1).trim();
    if (!serverId || !sessionId) {
        return {
            sessionId: normalizedKey,
            sessionKey: normalizedKey,
        };
    }

    return {
        sessionId,
        sessionKey: normalizedKey,
        serverId,
    };
}

export function buildServerScopedSessionKey(sessionId: string, serverId?: string | null): string {
    const normalizedSessionId = normalizeSessionKeyPart(sessionId);
    const normalizedServerId = normalizeSessionKeyPart(serverId);
    return normalizedServerId ? `${normalizedServerId}:${normalizedSessionId}` : normalizedSessionId;
}

export function buildVisibleSessionNavigationEntries(
    items: readonly SessionListLikeItem[] | null | undefined,
): VisibleSessionNavigationEntry[] {
    if (!items) return [];

    const entries: VisibleSessionNavigationEntry[] = [];
    items.forEach((item, index) => {
        if (item.type !== 'session') return;
        const sessionId = normalizeSessionKeyPart(item.sessionId);
        if (!sessionId) return;
        const serverId = normalizeSessionKeyPart(item.serverId);
        entries.push({
            index,
            sessionId,
            sessionKey: buildServerScopedSessionKey(sessionId, serverId),
            ...(serverId ? { serverId } : null),
        });
    });
    return entries;
}

/**
 * Which visible entry an active session id maps onto. Server scope wins when it is known —
 * two servers can hold the same session id — and a bare id still resolves so a route opened
 * without a `serverId` param (or a captured order built from an unscoped surface) still anchors.
 */
export function findVisibleSessionNavigationEntryByScope(
    entries: readonly VisibleSessionNavigationEntry[],
    sessionId: string,
    serverId: string | null | undefined,
): VisibleSessionNavigationEntry | null {
    const normalizedSessionId = normalizeSessionKeyPart(sessionId);
    if (!normalizedSessionId) return null;
    const normalizedServerId = normalizeSessionKeyPart(serverId) || null;
    if (normalizedServerId) {
        const scoped = entries.find((entry) =>
            entry.sessionId === normalizedSessionId && entry.serverId === normalizedServerId
        );
        if (scoped) return scoped;
    }
    return entries.find((entry) => entry.sessionId === normalizedSessionId) ?? null;
}

export function resolveVisibleSessionNavigation(params: Readonly<{
    visibleEntries: readonly VisibleSessionNavigationEntry[];
    activeSessionKey: string | null;
    cursorSessionKey: string | null;
    direction: SessionNavigationDirection;
}>): VisibleSessionNavigationEntry | null {
    const { visibleEntries, activeSessionKey, cursorSessionKey, direction } = params;
    if (visibleEntries.length === 0) return null;

    const anchorKey = cursorSessionKey ?? activeSessionKey;
    const anchorIndex = anchorKey
        ? visibleEntries.findIndex((entry) => entry.sessionKey === anchorKey)
        : -1;

    if (anchorIndex < 0) {
        return direction === 'previous'
            ? visibleEntries[visibleEntries.length - 1] ?? null
            : visibleEntries[0] ?? null;
    }

    const targetIndex = direction === 'previous'
        ? Math.max(0, anchorIndex - 1)
        : Math.min(visibleEntries.length - 1, anchorIndex + 1);
    return visibleEntries[targetIndex] ?? null;
}

export function resolveVisibleSessionEdgeNavigation(params: Readonly<{
    visibleEntries: readonly VisibleSessionNavigationEntry[];
    edge: 'first' | 'last';
}>): VisibleSessionNavigationEntry | null {
    if (params.visibleEntries.length === 0) return null;
    return params.edge === 'first'
        ? params.visibleEntries[0] ?? null
        : params.visibleEntries[params.visibleEntries.length - 1] ?? null;
}

export function moveSessionMruEntryToFront(params: Readonly<{
    order: readonly string[] | null | undefined;
    activeSessionKey: string | null;
    knownSessionKeys: readonly string[];
    maxEntries?: number;
}>): string[] {
    const known = new Set(params.knownSessionKeys.map(normalizeSessionKeyPart).filter(Boolean));
    const activeSessionKey = normalizeSessionKeyPart(params.activeSessionKey);
    const maxEntries = Math.max(0, params.maxEntries ?? DEFAULT_SESSION_MRU_MAX_ENTRIES);
    const next: string[] = [];

    if (activeSessionKey && known.has(activeSessionKey)) {
        next.push(activeSessionKey);
    }

    for (const rawKey of params.order ?? []) {
        const key = normalizeSessionKeyPart(rawKey);
        if (!key || !known.has(key) || next.includes(key)) continue;
        next.push(key);
        if (next.length >= maxEntries) break;
    }

    return next.slice(0, maxEntries);
}

export function resolveSessionMruNavigation(params: Readonly<{
    order: readonly string[];
    activeSessionKey: string | null;
    cursorSessionKey: string | null;
    direction: SessionNavigationDirection;
}>): VisibleSessionNavigationEntry | null {
    const order = params.order.map(normalizeSessionKeyPart).filter(Boolean);
    if (order.length === 0) return null;

    const anchorKey = normalizeSessionKeyPart(params.cursorSessionKey) || normalizeSessionKeyPart(params.activeSessionKey);
    const anchorIndex = anchorKey ? order.indexOf(anchorKey) : -1;
    if (anchorIndex < 0) {
        const fallbackIndex = params.direction === 'previous' ? 0 : order.length - 1;
        const sessionKey = order[fallbackIndex];
        return sessionKey ? { index: fallbackIndex, ...parseServerScopedSessionKey(sessionKey) } : null;
    }

    const delta = params.direction === 'previous' ? 1 : -1;
    const targetIndex = (anchorIndex + delta + order.length) % order.length;
    const sessionKey = order[targetIndex];
    return sessionKey ? { index: targetIndex, ...parseServerScopedSessionKey(sessionKey) } : null;
}
