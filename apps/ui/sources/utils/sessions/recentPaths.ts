import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { storage } from '@/sync/domains/state/storage';
import {
    readDisplayIdentityForSession,
    readMachineTargetForSession,
} from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type RecentPathSessionSource = Pick<
    Session,
    'id' | 'createdAt' | 'updatedAt' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView'
>
    | Pick<
        SessionListRenderableSession,
        'id' | 'createdAt' | 'updatedAt' | 'metadata' | 'metadataLayoutVersion'
    >;

export function getRecentPathsForMachine(params: {
    machineId: string;
    recentMachinePaths: ReadonlyArray<Readonly<{ machineId: string; path: string }>>;
    sessions: ReadonlyArray<RecentPathSessionSource | string> | null | undefined;
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
            if (typeof item === 'string') return;
            const session = item;
            const metadata = readSessionOwnerMetadataView({
                metadataLayoutVersion: 'metadataLayoutVersion' in session ? session.metadataLayoutVersion : undefined,
                metadata: session.metadata ?? null,
                ownerMetadataView: 'ownerMetadataView' in session ? session.ownerMetadataView : undefined,
            });
            if (!metadata) return;
            const reachableTarget = readMachineTargetForSession(session.id);
            // One display resolution per session: reading the machine id and the path separately
            // resolved the same target, and re-read the same project, twice per session.
            const displayIdentity = reachableTarget
                ? null
                : readDisplayIdentityForSession({ sessionId: null, metadata });
            const sessionMachineId = reachableTarget?.machineId ?? displayIdentity?.machineId ?? '';
            const path = reachableTarget?.basePath ?? displayIdentity?.basePath ?? '';
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
