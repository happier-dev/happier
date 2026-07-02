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

    it('executes transition actions only when explicitly requested', async () => {
        const durableComment = comment({ state: 'resolved' });
        serverFetchSpy.mockResolvedValueOnce(jsonResponse({ comment: durableComment }));
        const { createReviewCommentsHttpActionExecutor } = await import('./api');

        const execute = createReviewCommentsHttpActionExecutor();
        await expect(execute('reviews.comments.transition', {
            commentId: 'comment-1',
            toState: 'resolved',
            reason: 'Verified',
            clientMutationId: 'mutation-1',
        })).resolves.toEqual({ comment: durableComment });

        const [path, init] = serverFetchSpy.mock.calls[0] ?? [];
        expect(path).toBe('/v1/reviews/comments/comment-1/transition');
        expect(init).toEqual(expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({
                toState: 'resolved',
                reason: 'Verified',
                clientMutationId: 'mutation-1',
            }),
        }));
    });
});
