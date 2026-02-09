import { getServerProfileById } from '../domains/server/serverProfiles';
import { getActiveServerSnapshot } from '../domains/server/serverRuntime';
import { buildSessionListViewData, type SessionListViewItem } from '../domains/session/listing/sessionListViewData';
import type { Machine, Session } from '../domains/state/storageTypes';

export function buildSessionListViewDataWithServerScope(params: {
    sessions: Record<string, Session>;
    machines: Record<string, Machine>;
    groupInactiveSessionsByProject: boolean;
}): SessionListViewItem[] {
    const snapshot = getActiveServerSnapshot();
    const profile = getServerProfileById(snapshot.serverId);

    return buildSessionListViewData(
        params.sessions,
        params.machines,
        {
            groupInactiveSessionsByProject: params.groupInactiveSessionsByProject,
            serverScope: {
                serverId: snapshot.serverId,
                serverName: profile?.name,
            },
        }
    );
}
