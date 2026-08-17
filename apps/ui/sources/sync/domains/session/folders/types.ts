import { z } from 'zod';
import {
    SessionFolderV1Schema,
    SessionFolderWorkspaceRefV1Schema,
    SessionFoldersV1Schema,
    type SessionFolderV1,
    type SessionFolderWorkspaceRefV1,
    type SessionFoldersV1,
} from '@happier-dev/protocol/sessions';

export {
    SessionFolderV1Schema,
    SessionFolderWorkspaceRefV1Schema,
    SessionFoldersV1Schema,
    type SessionFolderV1,
    type SessionFolderWorkspaceRefV1,
    type SessionFoldersV1,
};

export type SessionFolderListDisplayState =
    | Readonly<{ status: 'available'; value: string }>
    | Readonly<{
        status: 'locked';
        reason:
            | 'account_key_unavailable'
            | 'content_unreadable'
            | 'invalid_stored_display'
            | 'storage_mode_mismatch';
    }>;

export type SessionFolderListItem = Omit<
    SessionFolderV1,
    'workspace'
> & Readonly<{
    workspace: SessionFolderWorkspaceRefV1 | null;
    displayState?: SessionFolderListDisplayState;
}>;

export type SessionFolderList = Readonly<{
    v: 1;
    folders: readonly SessionFolderListItem[];
}>;

export function selectAvailableSessionFolders(
    folders: SessionFolderList,
): SessionFoldersV1 {
    return {
        v: 1,
        folders: folders.folders.flatMap((folder) =>
            folder.workspace && folder.name
                ? [{ ...folder, workspace: folder.workspace }]
                : []),
    };
}

export const SessionFolderViewModeV1Schema = z.enum(['off', 'tree']);
export type SessionFolderViewModeV1 = z.infer<typeof SessionFolderViewModeV1Schema>;

export const SessionListFocusedFolderV1Schema = z.object({
    serverId: z.string().nullable(),
    workspace: SessionFolderWorkspaceRefV1Schema,
    renderWorkspaceKey: z.string().min(1).optional(),
    folderId: z.string().min(1),
}).nullable().catch(null);

export type SessionListFocusedFolderV1 = z.infer<typeof SessionListFocusedFolderV1Schema>;

export const DEFAULT_SESSION_FOLDERS_V1: SessionFoldersV1 = Object.freeze({
    v: 1,
    folders: [],
});
