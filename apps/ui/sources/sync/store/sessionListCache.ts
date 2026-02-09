import { getActiveServerSnapshot } from '../serverRuntime';
import type { SessionListViewItem } from '../sessionListViewData';

export function setServerSessionListCache(
    current: Record<string, SessionListViewItem[] | null>,
    serverIdRaw: string,
    sessionListViewData: SessionListViewItem[] | null,
): Record<string, SessionListViewItem[] | null> {
    const serverId = String(serverIdRaw ?? '').trim();
    if (!serverId) {
        return current;
    }
    return {
        ...current,
        [serverId]: sessionListViewData,
    };
}

export function setActiveServerSessionListCache(
    current: Record<string, SessionListViewItem[] | null>,
    sessionListViewData: SessionListViewItem[] | null,
): Record<string, SessionListViewItem[] | null> {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    return setServerSessionListCache(current, activeServerId, sessionListViewData);
}
