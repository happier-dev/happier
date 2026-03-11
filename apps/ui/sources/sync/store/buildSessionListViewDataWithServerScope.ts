import { getServerProfileById } from '../domains/server/serverProfiles';
import { getActiveServerSnapshot } from '../domains/server/serverRuntime';
import { buildSessionListViewData, type SessionListViewItem } from '../domains/session/listing/sessionListViewData';
import type { MachineDisplayRenderable } from '../domains/machines/machineDisplayRenderable';
import type { SessionListRenderableSession } from '../domains/session/listing/sessionListRenderable';

export function buildSessionListViewDataWithServerScope(params: {
    sessions: Record<string, SessionListRenderableSession>;
    machines: Record<string, MachineDisplayRenderable>;
    groupInactiveSessionsByProject: boolean;
    activeGroupingV1?: 'project' | 'date';
    inactiveGroupingV1?: 'project' | 'date';
}): SessionListViewItem[] {
    const snapshot = getActiveServerSnapshot();
    const profile = getServerProfileById(snapshot.serverId);

    return buildSessionListViewData(
        params.sessions,
        params.machines,
        {
            groupInactiveSessionsByProject: params.groupInactiveSessionsByProject,
            activeGroupingV1: params.activeGroupingV1,
            inactiveGroupingV1: params.inactiveGroupingV1,
            serverScope: {
                serverId: snapshot.serverId,
                serverName: profile?.name,
            },
        }
    );
}
