import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewCommentV1 } from '@happier-dev/protocol';

const serverFetchSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/http/client', () => ({
    serverFetch: serverFetchSpy,
}));

function comment(overrides: Partial<ReviewCommentV1> = {}): ReviewCommentV1 {
    return {
        v: 1,
        id: overrides.id ?? 'comment-1',
        accountId: 'account-1',
        projectId: overrides.projectId ?? 'project-1',
        workspaceId: overrides.workspaceId,
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

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('review comments HTTP action executor', () => {
    beforeEach(() => {
        serverFetchSpy.mockReset();
    });

    it('executes list actions through the authenticated review comments API', async () => {
        const durableComment = comment({ body: 'Loaded through HTTP.' });
        serverFetchSpy.mockResolvedValueOnce(jsonResponse({ items: [durableComment], cursor: null }));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');

        const execute = createReviewCommentsHttpActionExecutor();
        await expect(execute('reviews.comments.list', {
            projectId: 'project-1',
            sessionId: 'session-1',
            states: ['open'],
            folderPath: 'src/security',
            severity: 'critical',
            taxonomyIds: ['security.open_redirect', 'cwe.601'],
            includeHistory: true,
            limit: 10,
        })).resolves.toEqual({ items: [durableComment], cursor: null });

        expect(serverFetchSpy).toHaveBeenCalledTimes(1);
        const [path, init, options] = serverFetchSpy.mock.calls[0] ?? [];
        expect(String(path)).toContain('/v1/reviews/comments?');
        expect(String(path)).toContain('projectId=project-1');
        expect(String(path)).toContain('sessionId=session-1');
        expect(String(path)).toContain('states=open');
        expect(String(path)).toContain('folderPath=src%2Fsecurity');
        expect(String(path)).toContain('severity=critical');
        expect(String(path)).toContain('taxonomyIds=security.open_redirect');
        expect(String(path)).toContain('taxonomyIds=cwe.601');
        expect(String(path)).toContain('includeHistory=true');
        expect(String(path)).toContain('limit=10');
        expect(init).toEqual(expect.objectContaining({ method: 'GET' }));
        expect(options).toEqual(expect.objectContaining({ includeAuth: true }));
    });

    it('seals a plain transition event with request-known binding in the single mutation POST', async () => {
        const durableComment = comment({ state: 'resolved' });
        serverFetchSpy.mockResolvedValueOnce(jsonResponse({ comment: durableComment }));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');

        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({
                accountId: 'account-1',
                mode: 'plain',
            }),
        });
        await expect(execute('reviews.comments.transition', {
            projectId: 'project-1',
            commentId: 'comment-1',
            expectedState: 'open',
            expectedServerRevision: 1,
            toState: 'resolved',
            reason: 'Verified',
            clientMutationId: 'mutation-1',
        })).resolves.toEqual({ comment: durableComment });

        const [path, init] = serverFetchSpy.mock.calls[0] ?? [];
        expect(path).toBe('/v1/reviews/comments/comment-1/transition');
        expect(init).toEqual(expect.objectContaining({ method: 'POST' }));
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({
                projectId: 'project-1',
                expectedState: 'open',
                expectedServerRevision: 1,
                toState: 'resolved',
                reason: 'Verified',
                clientMutationId: 'mutation-1',
                eventEnvelope: {
                    t: 'plain',
                    v: {
                        v: 1,
                        requestBinding: expect.objectContaining({
                            accountId: 'account-1',
                            projectId: 'project-1',
                            actionId: 'reviews.comments.transition',
                            eventKind: 'transitioned',
                            actor: { kind: 'user', userId: 'account-1' },
                            target: { kind: 'comment', commentId: 'comment-1' },
                            expectedCurrentness: {
                                kind: 'transition',
                                expectedState: 'open',
                                expectedServerRevision: 1,
                            },
                        }),
                        details: expect.objectContaining({
                            commentId: 'comment-1',
                            reason: 'Verified',
                        }),
                    },
                },
            });
        expect(serverFetchSpy).toHaveBeenCalledTimes(1);
    });

    it('fails a token-only E2EE mutation before POST', async () => {
        const { createReviewCommentsHttpActionExecutor } = await import('./api');
        const execute = createReviewCommentsHttpActionExecutor({
            resolveEventStorageContext: async () => ({
                accountId: 'account-1',
                mode: 'e2ee',
            }),
        });

        await expect(execute('reviews.comments.create', {
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'body',
            clientMutationId: 'mutation-1',
        })).rejects.toThrow('review_comment_encryption_material_unavailable');
        expect(serverFetchSpy).not.toHaveBeenCalled();
    });

    it('claims one publication dispatch without manufacturing a comment mutation event', async () => {
        const claim = {
            disposition: 'dispatch' as const,
            publicationPlanId: 'P'.repeat(43),
            entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: 'A'.repeat(43) }],
            verdict: null,
        };
        serverFetchSpy.mockResolvedValueOnce(jsonResponse(claim));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');

        const execute = createReviewCommentsHttpActionExecutor();
        const target = {
            providerId: 'github',
            configuredAccountId: 'account-1',
            entryRef: {
                sourceId: 'github',
                kindId: 'pull-request-comment',
                collisionScope: 'repo-1',
                entryId: 'comment-1',
            },
            subtarget: null,
        };
        const publicationPlan = {
            target,
            baseRevision: 'base-1',
            headRevision: 'head-1',
            entries: [{
                happierCommentId: 'comment-1',
                expectedServerRevision: 1,
                anchor: { kind: 'file' as const, filePath: 'src/a.ts' },
                snapshot: { kind: 'too_large' as const, filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
                body: 'body',
            }],
            verdict: null,
        };
        await expect(execute('reviews.comments.claimPublicationDispatch', publicationPlan)).resolves.toEqual(claim);

        expect(serverFetchSpy).toHaveBeenCalledWith(
            '/v1/reviews/comments/publication/claim',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify(publicationPlan),
            }),
            { includeAuth: true },
        );
    });
});
