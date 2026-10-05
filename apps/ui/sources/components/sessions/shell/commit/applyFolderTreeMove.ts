import { moveSessionFolder, type SessionFoldersV1 } from '@/sync/domains/session/folders';

export type ApplyFolderTreeMoveResult = Readonly<{
    moved: boolean;
    next: SessionFoldersV1;
}>;

export async function applyFolderTreeMove(params: Readonly<{
    current: SessionFoldersV1;
    serverId: string;
    folderId: string;
    parentId: string | null;
    beforeFolderId?: string | null;
    afterFolderId?: string | null;
    now: number;
    setSessionFoldersV1: (next: SessionFoldersV1) => Promise<void>;
}>): Promise<ApplyFolderTreeMoveResult> {
    const moved = moveSessionFolder({
        current: params.current,
        serverId: params.serverId,
        folderId: params.folderId,
        parentId: params.parentId,
        beforeFolderId: params.beforeFolderId,
        afterFolderId: params.afterFolderId,
        now: params.now,
    });
    if (!moved.folder) {
        return { moved: false, next: params.current };
    }
    await params.setSessionFoldersV1(moved.next);
    return { moved: true, next: moved.next };
}
