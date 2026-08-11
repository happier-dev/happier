import type { Session } from '@/sync/domains/state/storageTypes';
import {
    readDisplayMachineIdForSession,
    readDisplayPathForSession,
    readMachineControlTargetForSession,
} from '@/sync/ops/sessionMachineTarget';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { storage } from '@/sync/domains/state/storage';
import { decodeSessionRecentPathEntry, type SessionRecentPathEntry } from './recentPathEntries';

export function getRecentPathsForMachine(params: {
    machineId: string;
    recentMachinePaths: ReadonlyArray<Readonly<{ machineId: string; path: string }>>;
    sessions: ReadonlyArray<Session | SessionRecentPathEntry | string> | null | undefined;
}): string[] {
    const paths: string[] = [];
    const pathSet = new Set<string>();
    // Canonicalisation runs once per recent entry and once per session below; the store's id-keyed
    // record is the index those lookups need, so it is used directly instead of a flattened list.
    const machines = storage.getState().machines ?? {};

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
            const sessionPathEntry = typeof item === 'string'
                ? decodeSessionRecentPathEntry(item)
                : null;
            if (typeof item === 'string' && !sessionPathEntry) return;

            const session = typeof item === 'string' ? null : item;
            const machineTarget = session ? readMachineControlTargetForSession(session.id) : null;
            const sessionMachineId = sessionPathEntry?.machineId ?? machineTarget?.machineId ?? (session
                ? readDisplayMachineIdForSession({
                    sessionId: session.id,
                    metadata: session.metadata ?? null,
                })
                : null);
            const path = sessionPathEntry?.path ?? machineTarget?.basePath ?? (session
                ? readDisplayPathForSession({
                    sessionId: session.id,
                    metadata: session.metadata ?? null,
                })
                : null);
            const canonical = sessionMachineId
                ? resolveCanonicalMachineId(sessionMachineId, machines)
                : null;
            const canonicalSessionMachineId = canonical?.machineId ?? sessionMachineId;
            if (canonicalSessionMachineId === params.machineId && path) {
                if (!pathSet.has(path)) {
                    pathSet.add(path);
                    pathsWithTimestamps.push({
                        path,
                        timestamp: sessionPathEntry?.createdAt ?? session?.updatedAt ?? session?.createdAt ?? 0,
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
