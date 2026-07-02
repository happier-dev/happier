import { describe, expect, it } from 'vitest';

import type { ReviewCommentV1 } from '@happier-dev/protocol';

import {
    applyReviewCommentList,
    createEmptyReviewCommentsState,
    upsertReviewComment,
} from './store';
import { selectReviewComments } from './selectors';

function comment(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
    return {
        v: 1,
        id: overrides.id ?? 'comment-1',
        accountId: 'account-1',
        projectId: overrides.projectId ?? 'project-1',
        runId: overrides.runId,
        engineId: overrides.engineId,
        anchor: overrides.anchor ?? { kind: 'file', filePath: 'src/a.ts' },
        snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
        body: overrides.body ?? 'body',
        bodyVersion: 1,
        edits: [],
        author: overrides.author ?? { kind: 'plugin', pluginId: 'review-coderabbit' },
        state: overrides.state ?? 'open',
        flags: overrides.flags ?? {},
        dispositions: {},
        threadId: overrides.threadId ?? overrides.id ?? 'comment-1',
        transitions: [
            {
                transitionId: 'transition-1',
                toState: overrides.state ?? 'open',
                transitionedAt: 1,
                transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
                serverRevision: 1,
            },
        ],
        createdAt: 1,
        updatedAt: overrides.updatedAt ?? 1,
        serverRevision: overrides.serverRevision ?? 1,
        ...overrides,
    };
}

describe('review comments UI state', () => {
    it('stores durable rows by id and filters by engine run state author and file', () => {
        const state = applyReviewCommentList(createEmptyReviewCommentsState(), {
            items: [
                comment({ id: 'c1', engineId: 'review-coderabbit', runId: 'run-1', state: 'open', updatedAt: 1 }),
                comment({ id: 'c2', engineId: 'review-deepsec', runId: 'run-2', state: 'resolved', updatedAt: 2 }),
            ],
            cursor: null,
        });

        expect(selectReviewComments(state, { engineId: 'review-coderabbit' }).map((row) => row.id)).toEqual(['c1']);
        expect(selectReviewComments(state, { runId: 'run-2', states: ['resolved'] }).map((row) => row.id)).toEqual(['c2']);
        expect(selectReviewComments(state, { filePath: 'src/a.ts', authorKind: 'plugin' }).map((row) => row.id)).toEqual(['c2', 'c1']);
    });

    it('replaces successful list results while preserving upsert semantics', () => {
        const state = applyReviewCommentList(createEmptyReviewCommentsState(), {
            items: [
                comment({ id: 'c1', updatedAt: 1 }),
                comment({ id: 'c2', updatedAt: 2 }),
            ],
            cursor: null,
        });

        const refreshed = applyReviewCommentList(state, {
            items: [comment({ id: 'c2', body: 'fresh server row', updatedAt: 3 })],
            cursor: null,
        });

        expect(selectReviewComments(refreshed).map((row) => row.id)).toEqual(['c2']);
        expect(selectReviewComments(refreshed)[0]?.body).toBe('fresh server row');

        const upserted = upsertReviewComment(refreshed, comment({ id: 'c3', updatedAt: 4 }));

        expect(selectReviewComments(upserted).map((row) => row.id)).toEqual(['c3', 'c2']);
    });
});
