export type SessionFolderDragTarget =
    | Readonly<{ type: 'folder'; folderId: string }>
    | Readonly<{ type: 'workspace-root' }>
    | Readonly<{ type: 'reorder'; beforeSessionId: string | null }>;

export type SessionFolderDragIntent =
    | Readonly<{ type: 'assign'; sessionId: string; folderId: string }>
    | Readonly<{ type: 'unassign'; sessionId: string }>
    | Readonly<{ type: 'reorder'; sessionId: string; beforeSessionId: string | null }>
    | Readonly<{ type: 'none' }>;

export function resolveSessionFolderDragIntent(params: Readonly<{
    draggedSessionId: string | null | undefined;
    target: SessionFolderDragTarget | null | undefined;
}>): SessionFolderDragIntent {
    const sessionId = String(params.draggedSessionId ?? '').trim();
    if (!sessionId || !params.target) return { type: 'none' };
    if (params.target.type === 'folder') {
        return { type: 'assign', sessionId, folderId: params.target.folderId };
    }
    if (params.target.type === 'workspace-root') {
        return { type: 'unassign', sessionId };
    }
    return { type: 'reorder', sessionId, beforeSessionId: params.target.beforeSessionId };
}
