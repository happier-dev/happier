import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { storage } from '@/sync/domains/state/storage';
import { readDisplayMachineIdForSession, readDisplayPathForSession } from '@/sync/ops/sessionMachineTarget';

type RecentPathSessionSource = Pick<Session, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>
    | Pick<SessionListRenderableSession, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>;

export function getRecentPathsForMachine(params: {
    machineId: string;
    recentMachinePaths: ReadonlyArray<Readonly<{ machineId: string; path: string }>>;
    sessions: ReadonlyArray<RecentPathSessionSource | string> | null | undefined;
}): string[] {
    const paths: string[] = [];
    const pathSet = new Set<string>();
    const machines = Object.values(storage.getState().machines ?? {});

    // First, add paths from recentMachinePaths (most recent first by storage order)
    for (const entry of params.recentMachinePaths) {
        const canonical = resolveCanonicalMachineId(entry.machineId, machines);
        const entryMachineId = canonical?.machineId ?? entry.machineId;
        if (entryMachineId === params.machineId && !pathSet.has(entry.path)) {
            paths.push(entry.path);
            pathSet.add(entry.path);
        }
    }

    // Then add paths from sessions if we need more
    if (params.sessions) {
        const pathsWithTimestamps: Array<{ path: string; timestamp: number }> = [];

        params.sessions.forEach((item) => {
            if (typeof item === 'string') return;
            const session = item;
            const sessionMachineId = readDisplayMachineIdForSession({
                sessionId: session.id,
                metadata: session.metadata ?? null,
            });
            const path = readDisplayPathForSession({
                sessionId: session.id,
                metadata: session.metadata ?? null,
            });
            if (sessionMachineId === params.machineId && path) {
                if (!pathSet.has(path)) {
                    pathSet.add(path);
                    pathsWithTimestamps.push({
                        path,
                        timestamp: session.updatedAt || session.createdAt,
                    });
                }
            }
        });

        pathsWithTimestamps
            .sort((a, b) => b.timestamp - a.timestamp)
            .forEach((item) => paths.push(item.path));
    }

    return paths;
}
