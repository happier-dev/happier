import type { SessionListViewItem } from './sessionListViewData';
import type { SessionListStorageFilter } from '../sessionStorageKind';
import { getSessionStorageKind } from '../sessionStorageKind';

export function filterSessionListViewDataByStorageKind(
    source: ReadonlyArray<SessionListViewItem>,
    storageKind: Exclude<SessionListStorageFilter, 'all'>,
): SessionListViewItem[] {
    const out: SessionListViewItem[] = [];
    let pendingServerHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;
    let pendingSectionHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;
    let pendingGroupHeader: Extract<SessionListViewItem, { type: 'header' }> | null = null;

    for (const item of source) {
        if (item.type === 'header') {
            if (item.headerKind === 'server') {
                pendingServerHeader = item;
                continue;
            }
            if (item.headerKind === 'active' || item.headerKind === 'inactive' || item.headerKind === 'sessions') {
                pendingSectionHeader = item;
                pendingGroupHeader = null;
                continue;
            }
            pendingGroupHeader = item;
            continue;
        }

        const kind = getSessionStorageKind(item.session);
        const visible = storageKind === 'persistedWithRetained'
            ? kind === 'persisted' || item.session.cloudCopyLeftAt != null
            : kind === storageKind;
        if (!visible) {
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
