

export type DetailsChromeTranslations = Readonly<{
    closeUnsavedTabA11y: string;
    emptyTitle: string;
    emptyReason: string;
    browseFiles: string;
    previewHint: string;
    reviewChanges: (params: Readonly<{ count: number }>) => string;
    reviewChangesReason: (params: Readonly<{ count: number }>) => string;
    splitNeedsWiderPane: string;
}>;


export const detailsChromeTranslationsEnglish = { en: {
        closeUnsavedTabA11y: 'Close tab, it has unsaved changes',
        emptyTitle: 'Files, changes and commits open here',
        browseFiles: 'Browse files',
        previewHint: 'One click opens a preview tab; open it again to keep it.',
        emptyReason: 'Files, changes and commits you open show up here, next to where you opened them.',
        reviewChanges: ({ count }) => (count === 1 ? 'Review 1 change' : `Review ${count} changes`),
        reviewChangesReason: ({ count }) => (count === 1
            ? '1 file changed in this session. Read it here without leaving the conversation.'
            : `${count} files changed in this session. Read them here without leaving the conversation.`),
        splitNeedsWiderPane: 'Side by side needs a wider pane. Widen Details or use Focus.',
    } } satisfies Pick<Record<string, DetailsChromeTranslations>, "en">;