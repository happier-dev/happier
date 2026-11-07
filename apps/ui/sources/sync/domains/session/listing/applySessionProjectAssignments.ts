import type { MachineDisplayRenderable } from '@/sync/domains/machines/machineDisplayRenderable';
import type { SessionProjectAssignments } from '../organization/projectAssignment';
import type { SessionListRenderableSession } from './sessionListRenderable';
import { buildSessionListViewData, type BuildSessionListViewDataOptions, type SessionListViewItem } from './sessionListViewData';

/** Apply organisation before folders, pins, filtering and ordering. Session objects stay untouched. */
export function applySessionProjectAssignments(
    source: SessionListViewItem[] | null,
    assignments: SessionProjectAssignments,
    options: BuildSessionListViewDataOptions,
): SessionListViewItem[] | null {
    if (!source || Object.keys(assignments).length === 0) return source;
    const affectedServers = new Set<string>();
    const byServer = new Map<string, SessionListViewItem[]>();
    for (const item of source) {
        const serverId = item.serverId ?? '';
        const rows = byServer.get(serverId) ?? [];
        rows.push(item);
        byServer.set(serverId, rows);
        if (item.type === 'session' && !item.session.owner && assignments[`${serverId}:${item.session.id}`]) affectedServers.add(serverId);
    }
    if (affectedServers.size === 0) return source;
    const result: SessionListViewItem[] = [];
    for (const [serverId, rows] of byServer) {
        if (!affectedServers.has(serverId)) {
            result.push(...rows);
            continue;
        }
        const sessions: Record<string, SessionListRenderableSession> = {};
        const machines: Record<string, MachineDisplayRenderable> = {};
        for (const item of rows) {
            if (item.type === 'session') sessions[item.session.id] = item.session;
            else if (item.machine) machines[item.machine.id] = item.machine;
        }
        result.push(...buildSessionListViewData(sessions, machines, {
            ...options,
            projectAssignmentsBySessionKey: assignments,
            serverScope: { serverId, serverName: rows[0]?.serverName },
        }));
    }
    return result;
}
