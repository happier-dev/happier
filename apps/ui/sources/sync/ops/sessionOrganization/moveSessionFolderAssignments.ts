import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { moveSessionFolderAssignments as moveSessionFolderAssignmentsApi } from '@/sync/api/session/sessionOrganizationApi';
import { getStorage } from '@/sync/domains/state/storageStore';
import { captureOrganizationAccount } from './organizationAccountGuard';

export async function moveSessionFolderAssignments(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    fromFolderIds: readonly string[];
    toFolderId: string | null;
}>): Promise<void> {
    const isAccountCurrent = captureOrganizationAccount();
    const recordId = getStorage().getState().moveSessionFolderAssignmentsOptimistic(
        params.serverId,
        params.fromFolderIds,
        params.toFolderId,
    );
    try {
        const response = await moveSessionFolderAssignmentsApi({
            credentials: params.credentials,
            serverUrl: params.serverUrl,
            request: {
                fromFolderIds: [...params.fromFolderIds],
                toFolderId: params.toFolderId,
            },
        });
        if (recordId) {
            getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        }
        if (!isAccountCurrent()) return;
        if (response.assignments.length > 0) {
            getStorage().getState().applySessionFolderAssignments(
                params.serverId,
                response.assignments.map((assignment) => ({
                    sessionId: assignment.sessionId,
                    folderId: response.toFolderId,
                })),
            );
        }
    } catch (error) {
        if (recordId) {
            getStorage().getState().rollbackSessionOrganizationOptimistic(recordId);
        }
        throw error;
    }
}
