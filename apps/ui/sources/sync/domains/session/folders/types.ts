import { z } from 'zod';
import {
    SessionFolderV1Schema,
    SessionFolderWorkspaceRefV1Schema,
    SessionFoldersV1Schema,
    type SessionFolderV1,
    type SessionFolderWorkspaceRefV1,
    type SessionFoldersV1,
} from '@happier-dev/protocol/sessionFolders';

export {
    SessionFolderV1Schema,
    SessionFolderWorkspaceRefV1Schema,
    SessionFoldersV1Schema,
    type SessionFolderV1,
    type SessionFolderWorkspaceRefV1,
    type SessionFoldersV1,
};

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
