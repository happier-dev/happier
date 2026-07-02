import { describe, expect, it, vi } from 'vitest';

import type { ReviewCommentActionIdV1, ReviewCommentV1 } from '@happier-dev/protocol';

import { createReviewCommentsActions } from './actions';

function comment(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
    return {
        v: 1,
        id: overrides.id ?? 'comment-1',
        accountId: 'account-1',
        projectId: 'project-1',
        anchor: { kind: 'file', filePath: 'src/a.ts' },
        snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
        body: overrides.body ?? 'body',
        bodyVersion: 1,
        edits: [],
        author: { kind: 'user', userId: 'user-1' },
        state: overrides.state ?? 'open',
        flags: {},
        dispositions: {},
        threadId: overrides.threadId ?? overrides.id ?? 'comment-1',
        transitions: [
            {
                transitionId: 'transition-1',
                toState: overrides.state ?? 'open',
                transitionedAt: 1,
                transitionedBy: { kind: 'user', userId: 'user-1' },
                serverRevision: 1,
            },
        ],
        createdAt: 1,
        updatedAt: 1,
        serverRevision: 1,
        ...overrides,
    };
}

describe('review comments UI actions', () => {
    it('executes durable comment operations through canonical action ids', async () => {
        const row = comment();
        const execute = vi.fn(async (actionId: ReviewCommentActionIdV1) => {
            if (actionId === 'reviews.comments.list') return { items: [], cursor: null };
            if (actionId === 'reviews.comments.reply') return { comment: comment({ id: 'comment-reply', parentCommentId: 'comment-1', threadId: 'comment-1' }), parent: row };
            if (actionId === 'reviews.comments.bulkTransition') return { bulkActionId: 'bulk-1', updated: [row], failed: [] };
            return { comment: row };
        });
        const actions = createReviewCommentsActions({ execute });

        await actions.list({ projectId: 'project-1' });
        await actions.create({
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'body',
            clientMutationId: 'mutation-1',
        });
        await actions.get({ commentId: 'comment-1' });
        await actions.transition({
            commentId: 'comment-1',
            toState: 'resolved',
            reason: 'fixed',
            clientMutationId: 'mutation-2',
        });
        await actions.edit({
            commentId: 'comment-1',
            nextBody: 'next body',
            clientMutationId: 'mutation-3',
        });
        await actions.reply({
            parentCommentId: 'comment-1',
            body: 'reply',
            clientMutationId: 'mutation-4',
        });
        await actions.redact({
            commentId: 'comment-1',
            redactBody: true,
            clientMutationId: 'mutation-5',
        });
        await actions.setDisposition({
            commentId: 'comment-1',
            disposition: 'working',
            clientMutationId: 'mutation-6',
        });
        await actions.attachEvidence({
            commentId: 'comment-1',
            evidence: [{ kind: 'reasoning', message: 'verified' }],
            clientMutationId: 'mutation-7',
        });
        await actions.bulkTransition({
            commentIds: ['comment-1'],
            toState: 'dismissed',
            reason: 'not actionable',
            clientMutationId: 'mutation-8',
        });

        expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual([
            'reviews.comments.list',
            'reviews.comments.create',
            'reviews.comments.get',
            'reviews.comments.transition',
            'reviews.comments.edit',
            'reviews.comments.reply',
            'reviews.comments.redact',
            'reviews.comments.setDisposition',
            'reviews.comments.attachEvidence',
            'reviews.comments.bulkTransition',
        ]);
    });
});
