import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveSessionOrganizationMutationScope } from '@/sync/domains/session/organization/mutationScope';
import type { SessionProjectAssignment } from '@/sync/domains/session/organization/projectAssignment';
import { setSessionAppearance } from './setSessionAppearance';
import { setSessionFolderAssignment } from './setSessionFolderAssignment';
import { fetchAndApplySessionFolderAssignments } from './fetchSessionFolderAssignments';

/** Uses only organisation APIs; execution metadata, provider identity and history are never written. */
export async function setSessionProjectAssignmentForServer(params: Readonly<{
    serverId: string | null | undefined;
    sessionId: string;
    project: SessionProjectAssignment | null;
}>): Promise<void> {
    const resolved = await resolveSessionOrganizationMutationScope(params.serverId);
    if (!resolved.ok) throw new Error(`session-project-scope-${resolved.reason}`);
    const scope = resolved.scope;
    const state = getStorage().getState();
    if (state.sessionOrganizationSessionAppearancesSupportedByServerId[scope.serverId] !== true) throw new Error('session-project-unsupported');
    const key = `${scope.serverId}:${params.sessionId}`;
    if (!Object.prototype.hasOwnProperty.call(state.sessionOrganizationFolderAssignmentsBySessionKey, key)) {
        await fetchAndApplySessionFolderAssignments({ ...scope, sessionIds: [params.sessionId], fetchPolicy: 'all' });
        if (!Object.prototype.hasOwnProperty.call(getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey, key)) throw new Error('session-project-folder-state-unavailable');
    }
    const previousFolder = getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[key] ?? null;
    if (previousFolder) await setSessionFolderAssignment({ ...scope, sessionId: params.sessionId, folderId: null });
    try {
        await setSessionAppearance({ ...scope, sessionId: params.sessionId, project: params.project });
    } catch (error) {
        if (previousFolder) {
            // Restore only our cleared assignment, never a newer folder choice.
            if (getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[key] == null) {
                try {
                    await setSessionFolderAssignment({ ...scope, sessionId: params.sessionId, folderId: previousFolder });
                } catch (restoreError) {
                    throw new AggregateError([error, restoreError], 'Project move and folder restoration failed');
                }
            }
        }
        throw error;
    }
}
