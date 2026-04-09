import { getSessionStorageKind, type SessionListStorageFilter } from '../sessionStorageKind';
import { normalizeTrimmedString } from './normalizeTrimmedString';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';

const EMPTY_SESSION_LIST_INDEX_ITEMS: SessionListIndexItem[] = [];

function resolveSessionRowForItem(
    item: Extract<SessionListIndexItem, { type: 'session' }>,
    resolveSessionRow: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null,
): SessionListRenderableSession | null {
    const serverId = normalizeTrimmedString(item.serverId) || null;
    const sessionId = normalizeTrimmedString(item.sessionId);
    if (!sessionId) return null;
    return resolveSessionRow(serverId, sessionId);
}

export function filterSessionListIndexByStorageKind(
    source: ReadonlyArray<SessionListIndexItem> | null | undefined,
    storageFilter: SessionListStorageFilter,
    resolveSessionRow?: (serverId: string | null | undefined, sessionId: string) => SessionListRenderableSession | null,
): SessionListIndexItem[] | null {
    if (!source) return null;
    if (storageFilter === 'all') return source as SessionListIndexItem[];

    const out: SessionListIndexItem[] = [];
    const pendingHeaders: Array<Extract<SessionListIndexItem, { type: 'header' }>> = [];
    let didChange = false;

    for (const item of source) {
        if (item.type === 'header') {
            pendingHeaders.push(item);
            continue;
        }

        if (item.type !== 'session') {
            didChange = true;
            continue;
        }

        const kind = item.storageKind != null
            ? item.storageKind
            : (resolveSessionRow ? getSessionStorageKind(resolveSessionRowForItem(item, resolveSessionRow)) : 'persisted');
        if (kind !== storageFilter) {
            didChange = true;
            continue;
        }

        if (pendingHeaders.length > 0) {
            out.push(...pendingHeaders);
            pendingHeaders.length = 0;
        }
        out.push(item);
    }

    if (out.length === 0) {
        return EMPTY_SESSION_LIST_INDEX_ITEMS;
    }

    if (!didChange && out.length === source.length) {
        let allSame = true;
        for (let index = 0; index < out.length; index += 1) {
            if (out[index] !== source[index]) {
                allSame = false;
                break;
            }
        }
        if (allSame) {
            return source as SessionListIndexItem[];
        }
    }

    return out;
}
