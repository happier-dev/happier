import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { createChangedFilesReviewDiffStateSource } from './ChangedFilesReviewDiffStore';
import { useChangedFilesReviewDiffBlockRenderer } from './useChangedFilesReviewDiffBlockRenderer';
import { renderHook } from '@/dev/testkit';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

type DiffBlockElementProps = Readonly<{
    filePath: string;
    estimatedChangedLines: number | null;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
}>;

const createDraft = (
    id: string,
    filePath: string,
    source: ReviewCommentDraft['source'],
): ReviewCommentDraft => ({
    id,
    filePath,
    source,
    anchor: {
        kind: 'diffLine',
        startLine: 1,
        side: 'after',
        oldLine: null,
        newLine: 1,
    },
    snapshot: {
        selectedLines: [],
        beforeContext: [],
        afterContext: [],
    },
    body: id,
    createdAt: 1,
});

describe('useChangedFilesReviewDiffBlockRenderer', () => {
    it('passes only matching diff drafts to each diff block', async () => {
        const matchingDraft = createDraft('matching', 'src/a.ts', 'diff');
        const unrelatedDiffDraft = createDraft('unrelated-diff', 'src/b.ts', 'diff');
        const unrelatedFileDraft = createDraft('unrelated-file', 'src/a.ts', 'file');

        const hook = await renderHook(() => useChangedFilesReviewDiffBlockRenderer({
            theme: {},
            sessionId: 'session-1',
            snapshotSignature: 'snapshot-1',
            workspaceScope: null,
            diffStateSource: createChangedFilesReviewDiffStateSource(),
            getEstimatedChangedLines: vi.fn(() => 12),
            reviewCommentsEnabled: true,
            reviewCommentDrafts: [
                matchingDraft,
                unrelatedDiffDraft,
                unrelatedFileDraft,
            ],
        }));

        const node = hook.getCurrent()('src/a.ts');

        if (!React.isValidElement<DiffBlockElementProps>(node)) {
            throw new Error('Expected diff block element');
        }

        expect(node.props.filePath).toBe('src/a.ts');
        expect(node.props.estimatedChangedLines).toBe(12);
        expect(node.props.reviewCommentDrafts).toEqual([matchingDraft]);

        await hook.unmount();
    });
});
