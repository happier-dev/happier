import type { WorkspaceAnchorResolutionV1 } from '@happier-dev/protocol';

import type { LineContentHash } from '@/utils/text/lineContentHash';

export type ReviewCommentSource = 'file' | 'diff';

export type ReviewCommentAnchor =
    | Readonly<{
        kind: 'fileLine';
        startLine: number;
        lineHash?: LineContentHash;
    }>
    | Readonly<{
        kind: 'diffLine';
        startLine: number;
        side: 'before' | 'after';
        oldLine: number | null;
        newLine: number | null;
        lineHash?: LineContentHash;
    }>
    | Readonly<{
        kind: 'line';
        filePath: string;
        line: number;
        side?: 'before' | 'after';
        lineHash?: LineContentHash;
    }>
    | Readonly<{
        kind: 'range';
        filePath: string;
        startLine: number;
        endLine: number;
        side?: 'before' | 'after';
        startLineHash?: LineContentHash;
        endLineHash?: LineContentHash;
        selectedTextHash?: LineContentHash;
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
    anchorResolution?: WorkspaceAnchorResolutionV1;
    snapshot: ReviewCommentSnapshot;
    body: string;
    includeInPrompt?: boolean;
    createdAt: number;
}>;
