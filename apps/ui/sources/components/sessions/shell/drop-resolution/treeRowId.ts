export const treeRowId = Object.freeze({
    folder: (id: string) => `folder:${id.trim()}`,
    session: (serverId: string, sessionId: string) => `session:${serverId.trim()}:${sessionId.trim()}`,
    workspaceRoot: (workspaceKey: string) => `workspace-root:${workspaceKey.trim()}`,
});

export function readFolderIdFromTreeRowId(rowId: string): string | null {
    const prefix = 'folder:';
    return rowId.startsWith(prefix) ? rowId.slice(prefix.length).trim() || null : null;
}
