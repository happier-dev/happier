import { z } from 'zod/mini';
import type { SessionOrganizationOpenedDisplayStateV1 } from '@happier-dev/protocol/sessions/organization/folders';
import {
    SessionFolderV1Schema,
    SessionFolderWorkspaceRefV1Schema,
    SessionFoldersV1Schema,
    type SessionFolderV1,
    type SessionFolderWorkspaceRefV1,
    type SessionFoldersV1,
} from '@happier-dev/protocol/sessions/folders/folderSettings';

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
    | Extract<SessionOrganizationOpenedDisplayStateV1, { status: 'locked' }>;

export type SessionFolderListItem = Omit<
    SessionFolderV1,
    'workspace'
> & Readonly<{
    serverId: string;
    workspace: SessionFolderWorkspaceRefV1 | null;
    displayState?: SessionFolderListDisplayState;
}>;

export type SessionFolderList = Readonly<{
    v: 1;
    folders: readonly SessionFolderListItem[];
}>;

/**
 * Whether two folder records describe the same stored folder definition.
 *
 * Timestamps are deliberately excluded: they move on every edit, so comparing them would turn a
 * no-op tree write into a real one. This is the one definition both the write planner and the
 * per-Home write partition use, so neither can decide "changed" differently from the other.
 */
export function areSessionFolderDefinitionsEqual(left: SessionFolderV1, right: SessionFolderV1): boolean {
    return left.name === right.name
        && left.parentId === right.parentId
        && (left.sortKey ?? null) === (right.sortKey ?? null)
        && JSON.stringify(left.workspace) === JSON.stringify(right.workspace);
}

export function selectAvailableSessionFolders(
    folders: SessionFolderList,
): SessionFoldersV1 {
    return {
        v: 1,
        folders: folders.folders.flatMap(({ serverId: _serverId, displayState: _displayState, ...folder }) =>
            folder.workspace && folder.name ? [{ ...folder, workspace: folder.workspace }] : []),
    };
}

export const SessionFolderViewModeV1Schema = z.enum(['off', 'tree']);
export type SessionFolderViewModeV1 = z.infer<typeof SessionFolderViewModeV1Schema>;

export const DEFAULT_SESSION_FOLDERS_V1: SessionFoldersV1 = Object.freeze({
    v: 1,
    folders: [],
});
