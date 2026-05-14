import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { moveSessionFolderAssignments as moveSessionFolderAssignmentsApi } from '@/sync/api/session/sessionFolderAssignmentsApi';
import { getStorage } from '@/sync/domains/state/storageStore';

export async function moveSessionFolderAssignments(params: Readonly<{
    credentials: AuthCredentials;
    serverId: string;
    serverUrl?: string;
    fromFolderIds: readonly string[];
    toFolderId: string | null;
}>): Promise<void> {
    const response = await moveSessionFolderAssignmentsApi({
        credentials: params.credentials,
        serverUrl: params.serverUrl,
        fromFolderIds: params.fromFolderIds,
        toFolderId: params.toFolderId,
    });
    if (response.assignments.length > 0) {
        getStorage().getState().applySessionFolderAssignments(
            params.serverId,
            response.assignments.map((assignment) => ({
                sessionId: assignment.sessionId,
                folderId: response.toFolderId,
            })),
        );
    }
}
