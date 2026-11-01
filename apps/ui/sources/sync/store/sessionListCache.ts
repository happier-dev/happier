import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '../domains/server/serverProfiles';
import { bindSessionListItemToServerScope } from '../domains/session/listing/sessionListPresentation';
import { getActiveServerSnapshot } from '../domains/server/serverRuntime';
import type { SessionListViewItem } from '../domains/session/listing/sessionListViewData';

export function setServerSessionListCache(
    current: Record<string, SessionListViewItem[] | null>,
    serverIdRaw: string,
    sessionListViewData: SessionListViewItem[] | null,
): Record<string, SessionListViewItem[] | null> {
    const serverId = resolveServerProfileScopeIdForIdentifier(serverIdRaw);
    if (!serverId) return current;
    const projected = sessionListViewData?.map((item) => bindSessionListItemToServerScope(item, serverId)) ?? null;
    const rows = projected && sessionListViewData
        && projected.every((item, index) => item === sessionListViewData[index]) ? sessionListViewData : projected;
    let next = current;
    for (const cachedServerId of Object.keys(current)) {
        if (cachedServerId !== serverId && areServerProfileIdentifiersEquivalent(cachedServerId, serverId)) {
            if (next === current) next = { ...current };
            delete next[cachedServerId];
        }
    }
    const existing = current[serverId];
    if (existing === rows || (existing && rows && existing.length === rows.length
        && existing.every((item, index) => item === rows[index]))) return next;
    return { ...next, [serverId]: rows };
}

export function clearServerSessionListCache(
    current: Record<string, SessionListViewItem[] | null>,
    serverIdRaw: string,
): Record<string, SessionListViewItem[] | null> {
    const serverId = resolveServerProfileScopeIdForIdentifier(serverIdRaw);
    if (!serverId) return current;
    let next = current;
    for (const cachedServerId of Object.keys(current)) {
        if (!areServerProfileIdentifiersEquivalent(cachedServerId, serverId)) continue;
        if (next === current) next = { ...current };
        delete next[cachedServerId];
    }
    return next;
}

export function setActiveServerSessionListCache(
    current: Record<string, SessionListViewItem[] | null>,
    sessionListViewData: SessionListViewItem[] | null,
): Record<string, SessionListViewItem[] | null> {
    const activeServerId = getActiveServerIdForSessionListCache();
    return setServerSessionListCache(current, activeServerId, sessionListViewData);
}

export function getActiveServerIdForSessionListCache(): string {
    return String(getActiveServerSnapshot().serverId ?? '').trim();
}
