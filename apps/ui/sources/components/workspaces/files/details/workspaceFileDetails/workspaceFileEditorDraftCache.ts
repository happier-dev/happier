export type WorkspaceFileEditorDraft = Readonly<{
    isEditingFile: boolean;
    editorOriginalText: string;
    editorOriginalHash?: string | null;
    editorText: string;
}>;

const cache = new Map<string, WorkspaceFileEditorDraft>();

function buildKey(workspaceCacheKey: string, filePath: string): string {
    return `${workspaceCacheKey}:${filePath}`;
}

export const workspaceFileEditorDraftCache = {
    getDraft(input: Readonly<{ workspaceCacheKey: string; filePath: string }>): WorkspaceFileEditorDraft | null {
        if (!input.workspaceCacheKey || !input.filePath) return null;
        return cache.get(buildKey(input.workspaceCacheKey, input.filePath)) ?? null;
    },
    setDraft(
        input: Readonly<{ workspaceCacheKey: string; filePath: string; draft: WorkspaceFileEditorDraft | null }>,
    ): void {
        if (!input.workspaceCacheKey || !input.filePath) return;
        const key = buildKey(input.workspaceCacheKey, input.filePath);
        if (!input.draft) {
            cache.delete(key);
            return;
        }
        cache.set(key, input.draft);
    },
};
