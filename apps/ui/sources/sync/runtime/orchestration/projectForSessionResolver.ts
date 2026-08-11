import type { Session } from '@/sync/domains/state/storageTypes';

import { projectManager, type Project } from './projectManager';
import { resolveProjectMachineScopeId } from './projectKeyIdentity';

export type ProjectKeyLookupResult =
    | Project
    | Readonly<{ key: Readonly<{ machineId: string; path: string }> }>
    | null;

/**
 * A **pure** project lookup: the project key `projectManager.addSession` would file each session
 * under, computed without registering anything.
 *
 * The store's `getProjectForSession` reads *by writing* — it calls `addSession`, which sets three
 * `Map`s per session. That is acceptable for a one-off read; it is not acceptable in a path that
 * runs over every session on every store publish, which is what the recent-path projection
 * (`useSessionRecentPathEntries`, evaluated inside zustand's snapshot-equality check) does.
 *
 * It does not need to register. `addSession` keys a record by
 * `{ machineId: resolveProjectMachineScopeId(metadata), path: metadata.path }` — derived entirely
 * from the metadata this resolver is handed. The manager holds something the record does not in
 * exactly one case: a session that *had* a path and no longer does, where `addSession`
 * early-returns and the previous mapping survives. That case, and only that case, consults it.
 *
 * This is the one owner of that derivation, so the key it returns can never drift from the one
 * `addSession` would file.
 */
export function resolveProjectForSession(
    sessions: Readonly<Record<string, Session>>,
    sessionId: string,
): ProjectKeyLookupResult {
    const metadata = sessions[sessionId]?.metadata ?? null;
    const path = typeof metadata?.path === 'string' ? metadata.path.trim() : '';
    if (metadata && path) {
        return { key: { machineId: resolveProjectMachineScopeId(metadata), path } };
    }
    return projectManager.getProjectForSession(sessionId);
}

export function createProjectForSessionResolver(
    sessions: Readonly<Record<string, Session>>,
): (sessionId: string) => ProjectKeyLookupResult {
    return (sessionId: string) => resolveProjectForSession(sessions, sessionId);
}
