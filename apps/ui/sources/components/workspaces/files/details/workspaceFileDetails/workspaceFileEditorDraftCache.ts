export type WorkspaceFileEditorDraft = Readonly<{
    accountId: string;
    isEditingFile: boolean;
    editorOriginalText: string;
    editorOriginalHash?: string | null;
    editorText: string;
}>;

/** Legacy unqualified bytes stay stored, but no reader may guess their Account owner. */
export function readWorkspaceFileEditorDraft(value: unknown, accountId: string | null): WorkspaceFileEditorDraft | null {
    if (!accountId?.trim() || !value || typeof value !== 'object') return null;
    const draft = value as Partial<Record<keyof WorkspaceFileEditorDraft, unknown>>;
    if (draft.accountId !== accountId || typeof draft.isEditingFile !== 'boolean'
        || typeof draft.editorOriginalText !== 'string' || typeof draft.editorText !== 'string') return null;
    return {
        accountId,
        isEditingFile: draft.isEditingFile,
        editorOriginalText: draft.editorOriginalText,
        editorOriginalHash: typeof draft.editorOriginalHash === 'string' ? draft.editorOriginalHash : null,
        editorText: draft.editorText,
    };
}

const cache = new Map<string, WorkspaceFileEditorDraft>();

export function buildWorkspaceFileEditorDraftKey(accountId: string | null, workspaceCacheKey: string, filePath: string): string {
    return JSON.stringify([accountId, workspaceCacheKey, filePath]);
}

export const workspaceFileEditorDraftCache = {
    getDraft(input: Readonly<{ accountId: string | null; workspaceCacheKey: string; filePath: string }>): WorkspaceFileEditorDraft | null {
        if (!input.accountId?.trim() || !input.workspaceCacheKey || !input.filePath) return null;
        return cache.get(buildWorkspaceFileEditorDraftKey(input.accountId, input.workspaceCacheKey, input.filePath)) ?? null;
    },
    setDraft(
        input: Readonly<{ accountId: string | null; workspaceCacheKey: string; filePath: string; draft: WorkspaceFileEditorDraft | null }>,
    ): void {
        if (!input.accountId?.trim() || !input.workspaceCacheKey || !input.filePath) return;
        if (input.draft && input.draft.accountId !== input.accountId) return;
        const key = buildWorkspaceFileEditorDraftKey(input.accountId, input.workspaceCacheKey, input.filePath);
        if (!input.draft) {
            cache.delete(key);
            return;
        }
        cache.set(key, input.draft);
    },
};
