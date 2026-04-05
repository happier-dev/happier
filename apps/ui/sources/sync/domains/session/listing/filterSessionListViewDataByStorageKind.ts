import type { SessionListViewItem } from './sessionListViewData';
import type { SessionStorageKind } from '../sessionStorageKind';
import { getSessionStorageKind } from '../sessionStorageKind';

export function filterSessionListViewDataByStorageKind(
    source: ReadonlyArray<SessionListViewItem>,
    storageKind: SessionStorageKind,
): SessionListViewItem[] {
    if (storageKind === 'all') {
        return source as SessionListViewItem[];
    }

    let pendingServerHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;
    let pendingSectionHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;
    let pendingGroupHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;
    let canReturnSource = true;

    for (const item of source) {
        if (item.type === 'header') {
            if (item.headerKind === 'server') {
                pendingServerHeader = item;
                continue;
            }
            if (item.headerKind === 'active' || item.headerKind === 'inactive') {
                pendingSectionHeader = item;
                pendingGroupHeader = null;
                continue;
            }
            pendingGroupHeader = item;
            continue;
        }

        if (getSessionStorageKind(item.session) !== storageKind) {
            canReturnSource = false;
            break;
        }

        pendingServerHeader = null;
        pendingSectionHeader = null;
        pendingGroupHeader = null;
    }

    if (
        canReturnSource
        && pendingServerHeader == null
        && pendingSectionHeader == null
        && pendingGroupHeader == null
    ) {
        return source as SessionListViewItem[];
    }

    const out: SessionListViewItem[] = [];
    pendingServerHeader = null;
    pendingSectionHeader = null;
    pendingGroupHeader = null;

    for (const item of source) {
        if (item.type === 'header') {
            if (item.headerKind === 'server') {
                pendingServerHeader = item;
                continue;
            }
            if (item.headerKind === 'active' || item.headerKind === 'inactive') {
                pendingSectionHeader = item;
                pendingGroupHeader = null;
                continue;
            }
            pendingGroupHeader = item;
            continue;
        }

        if (getSessionStorageKind(item.session) !== storageKind) {
            continue;
        }

        if (pendingServerHeader) out.push(pendingServerHeader);
        if (pendingSectionHeader) out.push(pendingSectionHeader);
        if (pendingGroupHeader) out.push(pendingGroupHeader);
        pendingServerHeader = null;
        pendingSectionHeader = null;
        pendingGroupHeader = null;
        out.push(item);
    }

    return out;
}
