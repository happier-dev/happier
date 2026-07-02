import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

export const treeRowId = Object.freeze({
    folder: (id: string) => `folder:${id.trim()}`,
    session: (serverId: string, sessionId: string) => `session:${serverId.trim()}:${sessionId.trim()}`,
    workspaceRoot: (workspaceKey: string) => `workspace-root:${workspaceKey.trim()}`,
});

export function resolveWorkspaceRootTreeRowId(item: Extract<SessionListIndexItem, { type: 'header' }>, fallbackTitle?: string): string {
    const baseKey = String(item.groupKey ?? item.workspaceKey ?? fallbackTitle ?? item.title ?? '').trim();
    const seedSessionId = String(item.seedSessionId ?? '').trim();
    return treeRowId.workspaceRoot(seedSessionId ? `${baseKey}:seed:${seedSessionId}` : baseKey);
}

export function readFolderIdFromTreeRowId(rowId: string): string | null {
    const prefix = 'folder:';
    return rowId.startsWith(prefix) ? rowId.slice(prefix.length).trim() || null : null;
}
