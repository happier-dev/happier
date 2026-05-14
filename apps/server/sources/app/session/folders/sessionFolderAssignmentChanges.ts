import { markAccountChanged } from "@/app/changes/markAccountChanged";
import type { Tx } from "@/storage/inTx";

export function buildSessionFolderAssignmentHint(folderId: string | null) {
    return { sessionFolderAssignment: true, folderId };
}

export function buildBulkSessionFolderAssignmentHint(params: Readonly<{
    folderIds: readonly string[];
    toFolderId: string | null;
}>) {
    return {
        sessionFolderAssignments: true,
        folderIds: [...params.folderIds],
        toFolderId: params.toFolderId,
    };
}

export async function markSessionFolderAssignmentChanged(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        sessionId: string;
        folderId: string | null;
    }>,
): Promise<number> {
    return await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "session",
        entityId: params.sessionId,
        hint: buildSessionFolderAssignmentHint(params.folderId),
    });
}

export async function markBulkSessionFolderAssignmentsChanged(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        folderIds: readonly string[];
        toFolderId: string | null;
    }>,
): Promise<number> {
    return await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: "account",
        entityId: "session-folder-assignments",
        hint: buildBulkSessionFolderAssignmentHint({
            folderIds: params.folderIds,
            toFolderId: params.toFolderId,
        }),
    });
}
