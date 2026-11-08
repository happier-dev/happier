import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { storage } from '@/sync/domains/state/storage';
import {
    readDisplayIdentityForSession,
    readMachineTargetForSession,
} from '@/sync/ops/sessionMachineTarget';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

type RecentPathSessionSource = (Pick<
    Session,
    'id' | 'createdAt' | 'updatedAt' | 'metadata' | 'metadataLayoutVersion' | 'ownerMetadataView'
>
    | Pick<
        SessionListRenderableSession,
        'id' | 'createdAt' | 'updatedAt' | 'metadata' | 'metadataLayoutVersion'
    >) & Readonly<{ serverId?: string }>;

/** The folder one Session ran in (its Machine and path), or null for a Happier-private folder or an unresolved one. */
function readSessionFolder(session: RecentPathSessionSource, preferProvidedSessionMetadata: boolean | undefined):
    Readonly<{ machineId: string; path: string; timestamp: number }> | null {
    const metadata = readSessionOwnerMetadataView({
        metadataLayoutVersion: 'metadataLayoutVersion' in session ? session.metadataLayoutVersion : undefined,
        metadata: session.metadata ?? null,
        ownerMetadataView: 'ownerMetadataView' in session ? session.ownerMetadataView : undefined,
    });
    // A private folder is never a recent folder (it is Happier's, not one the person chose).
    if (!metadata || readSessionDirectoryKind(metadata) === 'managed') return null;
    const reachableTarget = preferProvidedSessionMetadata ? null : readMachineTargetForSession(session.id);
    // One display resolution per session: reading the machine id and the path separately
    // resolved the same target, and re-read the same project, twice per session.
    const displayIdentity = reachableTarget
        ? null
        : readDisplayIdentityForSession({
            sessionId: preferProvidedSessionMetadata ? session.id : null,
            serverId: session.serverId,
            metadata,
            preferProvidedMetadata: preferProvidedSessionMetadata === true,
        });
    const machineId = reachableTarget?.machineId ?? displayIdentity?.machineId ?? '';
    const path = reachableTarget?.basePath ?? displayIdentity?.basePath ?? '';
    return machineId && path ? { machineId, path, timestamp: session.updatedAt || session.createdAt } : null;
}

/** Every folder these Sessions ran in, on any Machine, newest first and once each. */
export function listSessionFolders(sessions: ReadonlyArray<RecentPathSessionSource>):
    ReadonlyArray<Readonly<{ machineId: string; path: string; timestamp: number }>> {
    const newest = new Map<string, Readonly<{ machineId: string; path: string; timestamp: number }>>();
    for (const session of sessions) {
        const folder = readSessionFolder(session, false);
        if (!folder) continue;
        const key = `${folder.machineId}\u0000${folder.path}`;
        const known = newest.get(key);
        if (!known || folder.timestamp > known.timestamp) newest.set(key, folder);
    }
    return [...newest.values()].sort((a, b) => b.timestamp - a.timestamp);
}

export function getRecentPathsForMachine(params: {
    machineId: string;
    recentMachinePaths: ReadonlyArray<Readonly<{ machineId: string; path: string }>>;
    sessions: ReadonlyArray<RecentPathSessionSource | string> | null | undefined;
    /** The caller already projected exact-owner metadata; do not replace it through a bare-id store lookup. */
    preferProvidedSessionMetadata?: boolean;
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
            const folder = readSessionFolder(item, params.preferProvidedSessionMetadata);
            if (folder?.machineId === params.machineId && !pathSet.has(folder.path)) {
                pathSet.add(folder.path);
                pathsWithTimestamps.push({ path: folder.path, timestamp: folder.timestamp });
            }
        });

        pathsWithTimestamps
            .sort((a, b) => b.timestamp - a.timestamp)
            .forEach((item) => paths.push(item.path));
    }

    return paths;
}
