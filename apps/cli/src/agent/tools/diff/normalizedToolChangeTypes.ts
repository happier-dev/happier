export type NormalizedToolFileMutation = Readonly<{
    kind?: 'create' | 'update' | 'delete' | 'unknown';
    filePath?: string;
    oldText?: string | null;
    newText?: string | null;
}>;

export type NormalizedToolChangeResult = Readonly<{
    fileMutation?: NormalizedToolFileMutation | null;
}>;

export type PendingNormalizedToolChange =
    | Readonly<{
        kind: 'text-diff';
        filePath: string;
        oldText: string;
        newText: string;
        description?: string;
    }>
    | Readonly<{
        kind: 'placeholder-diff';
        filePath: string;
        description: string;
    }>
    | Readonly<{
        kind: 'canonical-diff';
        files: ReadonlyArray<Readonly<{
            filePath: string;
            unifiedDiff?: string;
            oldText?: string;
            newText?: string;
            description?: string;
        }>>;
    }>;
