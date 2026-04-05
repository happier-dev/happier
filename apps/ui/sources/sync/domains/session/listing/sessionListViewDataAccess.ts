import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionListViewItem } from './sessionListViewData';

export type SessionListViewDataSessionEntry = Readonly<{
    serverId: string | null;
    serverName: string | null;
    session: SessionListRenderableSession;
}>;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function normalizeOptionalName(raw: unknown): string | null {
    const name = normalizeId(raw);
    return name || null;
}

export function listSessionListViewDataSessions(
    items: ReadonlyArray<SessionListViewItem> | null | undefined | unknown,
): SessionListViewDataSessionEntry[] {
    const entries: SessionListViewDataSessionEntry[] = [];
    if (!Array.isArray(items)) {
        return entries;
    }

    for (const item of items) {
        if (!item || item.type !== 'session') continue;
        entries.push({
            serverId: normalizeId(item.serverId) || null,
            serverName: normalizeOptionalName(item.serverName),
            session: item.session,
        });
    }

    return entries;
}

export function findSessionListViewDataSession(
    items: ReadonlyArray<SessionListViewItem> | null | undefined | unknown,
    sessionIdRaw: string,
): SessionListViewDataSessionEntry | null {
    const sessionId = normalizeId(sessionIdRaw);
    if (!sessionId) return null;

    if (!Array.isArray(items)) {
        return null;
    }

    for (const item of items) {
        if (!item || item.type !== 'session') continue;
        if (normalizeId(item.session.id) === sessionId) {
            return {
                serverId: normalizeId(item.serverId) || null,
                serverName: normalizeOptionalName(item.serverName),
                session: item.session,
            };
        }
    }

    return null;
}

export function listSessionListViewDataSessionIds(
    items: ReadonlyArray<SessionListViewItem> | null | undefined | unknown,
    limit?: number,
): string[] {
    const max = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : null;
    if (max === 0) return [];

    const ids: string[] = [];
    if (!Array.isArray(items)) {
        return ids;
    }

    for (const item of items) {
        if (!item || item.type !== 'session') continue;
        ids.push(item.session.id);
        if (max !== null && ids.length >= max) {
            break;
        }
    }
    return ids;
}
