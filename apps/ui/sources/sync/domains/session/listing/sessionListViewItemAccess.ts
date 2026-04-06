import { normalizeTrimmedString } from './normalizeTrimmedString';
import type { SessionListViewItem } from './sessionListViewData';

export type SessionListViewSessionItem = Extract<SessionListViewItem, { type: 'session' }>;

const EMPTY_SESSION_LIST_VIEW_ITEMS: SessionListViewSessionItem[] = [];

export function listSessionListViewItems(
    items: ReadonlyArray<SessionListViewItem> | null | undefined | unknown,
): SessionListViewSessionItem[] {
    if (!Array.isArray(items)) {
        return EMPTY_SESSION_LIST_VIEW_ITEMS;
    }

    if (items.length === 0) {
        return EMPTY_SESSION_LIST_VIEW_ITEMS;
    }

    let hasNonSessionItem = false;
    for (const item of items) {
        if (!item || item.type !== 'session') {
            hasNonSessionItem = true;
            break;
        }
    }

    if (!hasNonSessionItem) {
        return items as SessionListViewSessionItem[];
    }

    const sessionItems: SessionListViewSessionItem[] = [];
    for (const item of items) {
        if (!item || item.type !== 'session') continue;
        sessionItems.push(item);
    }

    return sessionItems.length === 0 ? EMPTY_SESSION_LIST_VIEW_ITEMS : sessionItems;
}

export function findSessionListViewItemByNormalizedId(
    items: ReadonlyArray<SessionListViewItem> | null | undefined | unknown,
    sessionId: string,
): SessionListViewSessionItem | null {
    if (!sessionId) return null;

    if (!Array.isArray(items)) {
        return null;
    }

    for (const item of items) {
        if (!item || item.type !== 'session') continue;
        if (normalizeTrimmedString(item.session.id) === sessionId) {
            return item;
        }
    }

    return null;
}

export function findSessionListViewItem(
    items: ReadonlyArray<SessionListViewItem> | null | undefined | unknown,
    sessionIdRaw: string,
): SessionListViewSessionItem | null {
    const sessionId = normalizeTrimmedString(sessionIdRaw);
    if (!sessionId) return null;

    return findSessionListViewItemByNormalizedId(items, sessionId);
}
