type SessionFileEditorDraft = Readonly<{
    isEditingFile: boolean;
    editorOriginalText: string;
    editorText: string;
}>;

const cache = new Map<string, SessionFileEditorDraft>();

function buildKey(sessionId: string, filePath: string): string {
    return `${sessionId}:${filePath}`;
}

export const sessionFileEditorDraftCache = {
    getDraft(input: Readonly<{ sessionId: string; filePath: string }>): SessionFileEditorDraft | null {
        if (!input.sessionId || !input.filePath) return null;
        return cache.get(buildKey(input.sessionId, input.filePath)) ?? null;
    },
    setDraft(
        input: Readonly<{ sessionId: string; filePath: string; draft: SessionFileEditorDraft | null }>,
    ): void {
        if (!input.sessionId || !input.filePath) return;
        const key = buildKey(input.sessionId, input.filePath);
        if (!input.draft) {
            cache.delete(key);
            return;
        }
        cache.set(key, input.draft);
    },
};

