import { moveSessionFolder, type SessionFoldersV1 } from '@/sync/domains/session/folders';

export type ApplyFolderTreeMoveResult = Readonly<{
    moved: boolean;
    next: SessionFoldersV1;
}>;

export function applyFolderTreeMove(params: Readonly<{
    current: SessionFoldersV1;
    folderId: string;
    parentId: string | null;
    beforeFolderId?: string | null;
    afterFolderId?: string | null;
    now: number;
    setSessionFoldersV1: (next: SessionFoldersV1) => void;
}>): ApplyFolderTreeMoveResult {
    const moved = moveSessionFolder({
        current: params.current,
        folderId: params.folderId,
        parentId: params.parentId,
        beforeFolderId: params.beforeFolderId,
        afterFolderId: params.afterFolderId,
        now: params.now,
    });
    if (!moved.folder) {
        return { moved: false, next: params.current };
    }
    params.setSessionFoldersV1(moved.next);
    return { moved: true, next: moved.next };
}
