import { normalizeWorkspaceScopeBase, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { compareSessionFolderWorkspaceRefs } from './workspaceRefs';

/**
 * The folder a 'New session in folder' launch should file its session into.
 *
 * Session folders belong to one server, machine and workspace path. The launch keeps the folder
 * only while it actually starts in that same scope; the wizard lets the user switch machine,
 * directory or server afterwards, and a session created elsewhere must not be filed into a folder
 * it would not be shown under.
 */
export type NewSessionTargetFolderV1 = Readonly<{
    folderId: string;
    workspace: WorkspaceScopeBase;
}>;

function normalizeString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function buildNewSessionTargetFolder(params: Readonly<{
    folderId: string | null | undefined;
    serverId: string | null | undefined;
    machineId: string | null | undefined;
    rootPath: string | null | undefined;
}>): NewSessionTargetFolderV1 | null {
    const folderId = normalizeString(params.folderId);
    const workspace = normalizeWorkspaceScopeBase({
        serverId: normalizeString(params.serverId),
        machineId: normalizeString(params.machineId),
        rootPath: params.rootPath ?? '',
    });
    if (!folderId || !workspace) return null;
    return { folderId, workspace };
}

/** Re-reads a target folder persisted with a draft; drops anything that is not a complete scope. */
export function readNewSessionTargetFolder(value: unknown): NewSessionTargetFolderV1 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const workspace = record.workspace;
    if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) return null;
    const workspaceRecord = workspace as Record<string, unknown>;
    return buildNewSessionTargetFolder({
        folderId: typeof record.folderId === 'string' ? record.folderId : null,
        serverId: typeof workspaceRecord.serverId === 'string' ? workspaceRecord.serverId : null,
        machineId: typeof workspaceRecord.machineId === 'string' ? workspaceRecord.machineId : null,
        rootPath: typeof workspaceRecord.rootPath === 'string' ? workspaceRecord.rootPath : null,
    });
}

/**
 * Returns the folder assignment to apply once the session was created, or null when the launch
 * landed outside the folder's workspace scope.
 */
export function resolveCreatedSessionTargetFolder(params: Readonly<{
    targetFolder: NewSessionTargetFolderV1 | null | undefined;
    serverId: string | null | undefined;
    machineId: string | null | undefined;
    directory: string | null | undefined;
}>): NewSessionTargetFolderV1 | null {
    const targetFolder = params.targetFolder;
    if (!targetFolder) return null;
    const launchScope = normalizeWorkspaceScopeBase({
        serverId: normalizeString(params.serverId),
        machineId: normalizeString(params.machineId),
        rootPath: params.directory ?? '',
    });
    const folderScope = normalizeWorkspaceScopeBase(targetFolder.workspace);
    if (!launchScope || !folderScope) return null;
    return compareSessionFolderWorkspaceRefs(
        { t: 'workspaceScope', ...launchScope },
        { t: 'workspaceScope', ...folderScope },
    )
        ? { folderId: targetFolder.folderId, workspace: folderScope }
        : null;
}
