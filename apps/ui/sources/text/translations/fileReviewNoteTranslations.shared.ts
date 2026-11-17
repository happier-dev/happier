type Paths = Readonly<{ paths: string }>;
type Changes = Paths & Readonly<{ count: number | null }>;
export type Labels = Readonly<{
    discard: (params: Changes) => string;
    restore: (params: Paths) => string;
    restoreBeforeTurn: (params: Paths & Readonly<{ turn: string }>) => string;
    undoDiscard: (params: Paths) => string;
    undoRestore: (params: Paths) => string;
    undo: (params: Paths) => string;
}>;

export const fileReviewNoteTranslations = {
    en: {
        discard: ({ paths, count }) => `You discarded ${count === null ? 'changes' : `${count} ${count === 1 ? 'change' : 'changes'}`} in ${paths}`,
        restore: ({ paths }) => `You restored ${paths} to its before state`,
        restoreBeforeTurn: ({ paths, turn }) => `You restored ${paths} to before ${turn}`,
        undoDiscard: ({ paths }) => `You undid the discard in ${paths}`,
        undoRestore: ({ paths }) => `You undid the restore in ${paths}`,
        undo: ({ paths }) => `You undid the review action in ${paths}`,
    },
} as const satisfies Pick<Record<string, Labels>, 'en'>;
