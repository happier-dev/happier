import type { Machine } from '@/sync/domains/state/storageTypes';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';

type RecentMachineSessionSource = Pick<Session, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>
    | Pick<SessionListRenderableSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>;

export function getRecentMachinesFromSessions(params: {
    machines: Machine[];
    sessions: Array<RecentMachineSessionSource | string> | null | undefined;
}): Machine[] {
    if (!params.sessions || params.machines.length === 0) return [];

    const byId = new Map(params.machines.map((m) => [m.id, m] as const));
    const seen = new Set<string>();
    const machinesWithTimestamp: Array<{ machine: Machine; timestamp: number }> = [];

    params.sessions.forEach((item) => {
        if (typeof item === 'string') return;
        const machineId = readDisplayMachineIdForSession({
            sessionId: item.id,
            metadata: item.metadata ?? null,
        });
        if (!machineId || seen.has(machineId)) return;
        const machine = byId.get(machineId);
        if (!machine) return;
        seen.add(machineId);
        machinesWithTimestamp.push({
            machine,
            timestamp: item.updatedAt || item.createdAt,
        });
    });

    return machinesWithTimestamp
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((item) => item.machine);
}
