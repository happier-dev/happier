import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import { normalizeWorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { projectManager, resolveProjectMachineScopeId, type Project } from './projectManager';

export type ProjectKeyLookupResult =
    | Project
    | Readonly<{ key: Readonly<{ serverId: string; machineId: string; rootPath: string }> }>
    | null;

/**
 * A **pure** project lookup: the project key `projectManager.addSession` would file each session
 * under, computed without registering anything.
 *
 * The store's `getProjectForSession` reads *by writing* — it calls `addSession`, which sets several
 * `Map`s per session. That is acceptable for a one-off read; it is not acceptable inside a zustand
 * selector, which is re-evaluated as the snapshot-equality check for every mounted consumer on
 * every publish.
 *
 * It does not need to register. `addSession` files a session under
 * `normalizeWorkspaceScopeBase({ serverId, machineId: resolveProjectMachineScopeId(metadata),
 * rootPath: metadata.path })` — derived entirely from the metadata this resolver is handed, except
 * for `serverId`, which no reader of this result consults (callers read `key.machineId` and
 * `key.rootPath`). The manager holds something the derivation does not in exactly one case: a
 * session that *had* a path and no longer does, or one the store no longer knows, where
 * `addSession` early-returns and the previous mapping survives. That case, and only that case,
 * consults it.
 */
export function resolveProjectForSession(
    sessions: Readonly<Record<string, Session>>,
    sessionId: string,
): ProjectKeyLookupResult {
    const session = sessions[sessionId] ?? null;
    const metadata = session ? readSessionOwnerMetadataView(session) : null;
    if (metadata?.path) {
        const serverId =
            session && 'serverId' in session && typeof session.serverId === 'string'
                ? session.serverId.trim()
                : '';
        const normalized = normalizeWorkspaceScopeBase({
            // `addSession` substitutes this same placeholder rather than declining to file, and no
            // reader of the result consults it.
            serverId: serverId || 'unknown',
            machineId: resolveProjectMachineScopeId(metadata),
            rootPath: metadata.path,
        });
        if (normalized) return { key: normalized };
    }
    return projectManager.getProjectForSession(sessionId);
}

export function createProjectForSessionResolver(
    sessions: Readonly<Record<string, Session>>,
): (sessionId: string) => ProjectKeyLookupResult {
    return (sessionId: string) => resolveProjectForSession(sessions, sessionId);
}
