

export type Count = Readonly<{ count: number }>;



export type DetailsReviewTranslations = Readonly<{
    title: string;
    files: (params: Count) => string;
    nextCommit: (params: Count) => string;
    changedFiles: string;
    commitColumn: string;
    jumpA11y: string;
    comments: (params: Count) => string;
    goesWithNext: (params: Count) => string;
    askForChanges: string;
    detachCommentA11y: string;
    trayExpandedHint: string;
    askPlaceholder: string;
    send: string;
    draftAuthor: string;
    draftStatus: string;
    includeComment: string;
}>;


export const detailsReviewTranslationsEnglish = { en: {
        title: 'Review',
        files: ({ count }) => (count === 1 ? `1 file` : `${count} files`),
        nextCommit: ({ count }) => `${count} in the next commit`,
        changedFiles: 'Changed files',
        commitColumn: 'Commit',
        jumpA11y: 'Jump to a file',
        comments: ({ count }) => (count === 1 ? `1 comment` : `${count} comments`),
        goesWithNext: ({ count }): string => (count === 1 ? `goes with your next message` : `go with your next message`),
        askForChanges: 'Ask for changes',
        detachCommentA11y: 'Leave this comment out of the next message',
        trayExpandedHint: 'They go with your next message to the agent.',
        askPlaceholder: 'Tell the agent what to change…',
        send: 'Send',
        draftAuthor: 'You', draftStatus: 'draft', includeComment: 'Goes with your next message',
    } } satisfies Pick<Record<string, DetailsReviewTranslations>, "en">;