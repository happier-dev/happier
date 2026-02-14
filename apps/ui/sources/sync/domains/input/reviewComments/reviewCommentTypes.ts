export type ReviewCommentSource = 'file' | 'diff';

export type ReviewCommentAnchor =
    | Readonly<{
        kind: 'fileLine';
        startLine: number;
    }>
    | Readonly<{
        kind: 'diffLine';
        startLine: number;
        side: 'before' | 'after';
        oldLine: number | null;
        newLine: number | null;
    }>;

export type ReviewCommentSnapshot = Readonly<{
    selectedLines: readonly string[];
    beforeContext: readonly string[];
    afterContext: readonly string[];
}>;

export type ReviewCommentDraft = Readonly<{
    id: string;
    filePath: string;
    source: ReviewCommentSource;
    anchor: ReviewCommentAnchor;
    snapshot: ReviewCommentSnapshot;
    body: string;
    createdAt: number;
}>;

