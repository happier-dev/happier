export function buildSessionFolderAssignmentKey(serverId: string | null | undefined, sessionId: string): string {
    return `${String(serverId ?? 'local').trim() || 'local'}:${sessionId}`;
}
