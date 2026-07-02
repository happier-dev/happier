import { describe, expect, it, vi } from 'vitest';

import type {
    ReviewCommentCreateRequestV1,
    ReviewCommentCreateResponseV1,
} from '@happier-dev/protocol';

import { buildDurableReviewCommentCreateRequestFromDraft, submitDurableReviewCommentDraft } from './promoteDraft';

function draft() {
    return {
        id: 'draft-1',
        filePath: 'src/a.ts',
        source: 'file' as const,
        anchor: { kind: 'fileLine' as const, startLine: 4 },
        snapshot: {
            selectedLines: ['return value.name;'],
            beforeContext: ['function read(value?: User) {'],
            afterContext: ['}'],
        },
        body: 'Null-check before dereferencing.',
        createdAt: 1,
    };
}

describe('buildDurableReviewCommentCreateRequestFromDraft', () => {
    it('promotes a local draft to a durable create request without deleting local draft state', () => {
        const request = buildDurableReviewCommentCreateRequestFromDraft({
            projectId: 'project-1',
            clientMutationId: 'mutation-1',
            draft: draft(),
        });

        expect(request).toMatchObject({
            projectId: 'project-1',
            anchor: { kind: 'line', filePath: 'src/a.ts', line: 4 },
            body: 'Null-check before dereferencing.',
            authorIntent: 'propose',
            clientMutationId: 'mutation-1',
        });
        expect('kind' in request.snapshot ? request.snapshot.kind : null).toBe('text');
    });

    it('submits the durable create action only when explicitly invoked and clears the local draft after success', async () => {
        const createResponse = {
            comment: {
                v: 1,
                id: 'comment-1',
                accountId: 'account-1',
                projectId: 'project-1',
                anchor: { kind: 'line', filePath: 'src/a.ts', line: 4 },
                snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
                body: 'Null-check before dereferencing.',
                bodyVersion: 1,
                edits: [],
                author: { kind: 'user', userId: 'user-1' },
                state: 'proposed',
                flags: {},
                dispositions: {},
                threadId: 'comment-1',
                transitions: [],
                createdAt: 1,
                updatedAt: 1,
                serverRevision: 1,
            },
        } satisfies ReviewCommentCreateResponseV1;
        const create = vi.fn<(input: ReviewCommentCreateRequestV1) => Promise<ReviewCommentCreateResponseV1>>(async () => createResponse);
        const onPromoted = vi.fn();
        const localDraft = draft();

        expect(create).not.toHaveBeenCalled();

        const response = await submitDurableReviewCommentDraft({
            projectId: 'project-1',
            clientMutationId: 'mutation-1',
            draft: localDraft,
            actions: { create },
            onPromoted,
        });

        expect(response.comment.id).toBe('comment-1');
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0]?.[0]).toMatchObject({
            projectId: 'project-1',
            body: 'Null-check before dereferencing.',
            clientMutationId: 'mutation-1',
        });
        expect(onPromoted).toHaveBeenCalledWith({
            draftId: 'draft-1',
            commentId: 'comment-1',
        });
    });
});
