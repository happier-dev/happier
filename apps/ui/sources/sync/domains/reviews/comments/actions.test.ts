import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sealReviewCommentSensitiveEnvelopeV1, splitReviewCommentV1, type ReviewCommentV1 } from '@happier-dev/protocol';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let homeId: string;
let webLocks: ReturnType<typeof installWebLockManagerMock>;

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
    beforeEach(async () => {
        webLocks = installWebLockManagerMock();
        homeId = await homes.addHome({ name: 'Review Home', serverUrl: 'https://review-actions.test', accountId: 'account-1' });
    });
    afterEach(async () => {
        await homes.reset();
        vi.restoreAllMocks();
        webLocks.restore();
    });

    it('executes durable comment operations through their real Action HTTP owner', async () => {
        const row = comment();
        const split = splitReviewCommentV1(row);
        const listPath = '/v1/reviews/comments?projectId=project-1&states=open&includeHistory=false&limit=50&stored=true';
        const getPath = '/v1/reviews/comments/comment-1?stored=true&includeHistory=true';
        homes.answer(homeId, listPath, { body: { items: [], cursor: null } });
        homes.answer(homeId, getPath, { body: { comment: {
            v: 1, structural: split.structural,
            sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ ...split, mode: 'plain' }),
        } } });
        for (const path of [
            'POST /v1/reviews/comments', 'PATCH /v1/reviews/comments/comment-1',
            '/v1/reviews/comments/comment-1/transition', '/v1/reviews/comments/comment-1/redact',
            '/v1/reviews/comments/comment-1/disposition', '/v1/reviews/comments/comment-1/evidence',
        ]) homes.answer(homeId, path, { body: { comment: row } });
        homes.answer(homeId, '/v1/reviews/comments/comment-1/reply', { body: {
            comment: comment({ id: 'comment-reply', parentCommentId: 'comment-1', threadId: 'comment-1' }), parent: row,
        } });
        homes.answer(homeId, '/v1/reviews/comments/bulkTransition', { body: { bulkActionId: 'bulk-1', updated: [row], failed: [] } });
        const { createReviewCommentsHttpActionExecutor } = await import('./api');
        const { createReviewCommentsActions } = await import('./actions');
        const actions = createReviewCommentsActions({ execute: createReviewCommentsHttpActionExecutor() });

        await expect(actions.list({ projectId: 'project-1', states: ['open'] })).resolves.toEqual({ items: [], cursor: null });
        await actions.create({
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'body',
            clientMutationId: 'mutation-1',
        });
        await expect(actions.get({ commentId: 'comment-1' })).resolves.toEqual({ comment: row });
        await actions.transition({
            commentId: 'comment-1',
            toState: 'resolved',
            expectedState: row.state,
            expectedServerRevision: row.serverRevision,
            reason: 'fixed',
            clientMutationId: 'mutation-2',
        });
        await actions.edit({
            commentId: 'comment-1',
            nextBody: 'next body',
            expectedBodyVersion: row.bodyVersion,
            expectedServerRevision: row.serverRevision,
            clientMutationId: 'mutation-3',
        });
        await actions.reply({
            parentCommentId: 'comment-1',
            expectedParentServerRevision: row.serverRevision,
            body: 'reply',
            clientMutationId: 'mutation-4',
        });
        await actions.redact({
            commentId: 'comment-1',
            redactBody: true,
            expectedServerRevision: row.serverRevision,
            clientMutationId: 'mutation-5',
        });
        await actions.setDisposition({
            commentId: 'comment-1',
            disposition: 'working',
            expectedServerRevision: row.serverRevision,
            clientMutationId: 'mutation-6',
        });
        await actions.attachEvidence({
            commentId: 'comment-1',
            evidence: [{ kind: 'reasoning', message: 'verified' }],
            expectedServerRevision: row.serverRevision,
            clientMutationId: 'mutation-7',
        });
        await actions.bulkTransition({
            commentIds: ['comment-1'],
            toState: 'dismissed',
            expectedState: row.state,
            expectedServerRevisions: { [row.id]: row.serverRevision },
            reason: 'not actionable',
            clientMutationId: 'mutation-8',
        });

        expect(homes.requests.filter(({ path }) => path.startsWith('/v1/reviews/comments')).map(({ path }) => path)).toEqual([
            listPath, '/v1/reviews/comments', getPath,
            '/v1/reviews/comments/comment-1/transition', '/v1/reviews/comments/comment-1',
            '/v1/reviews/comments/comment-1/reply', '/v1/reviews/comments/comment-1/redact',
            '/v1/reviews/comments/comment-1/disposition', '/v1/reviews/comments/comment-1/evidence',
            '/v1/reviews/comments/bulkTransition',
        ]);
        expect(homes.requestsFor('/v1/reviews/comments/comment-1/transition')[0]?.input).toMatchObject({
            expectedState: row.state, expectedServerRevision: row.serverRevision,
            toState: 'resolved', clientMutationId: 'mutation-2',
        });
        expect(homes.requestsFor('/v1/reviews/comments/bulkTransition')[0]?.input).toMatchObject({
            expectedState: row.state, expectedServerRevisions: { [row.id]: row.serverRevision },
        });
    });
});
