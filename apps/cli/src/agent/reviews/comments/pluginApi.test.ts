import { describe, expect, it, vi } from 'vitest';

import { createPluginReviewCommentsService } from './pluginApi';

describe('createPluginReviewCommentsService', () => {
    it('delegates snapshot resolution to the bound host resolver', async () => {
        const resolvedSnapshot = {
            kind: 'text' as const,
            selectedLines: ['line 4'],
            beforeContext: [],
            afterContext: [],
            selectedLinesHash: 'selected-hash',
            contextWindowHash: 'context-hash',
            capturedAt: 1,
            fileLength: 1,
            source: 'workingTree' as const,
            isUncommitted: true,
            isUntracked: false,
            truncated: false,
            hasBidiControls: false,
            likelyMinified: false,
        };
        const resolveSnapshot = vi.fn(async () => resolvedSnapshot);
        const service = createPluginReviewCommentsService({
            execute: vi.fn(),
            resolveSnapshot,
        });
        const serviceWithResolver = service as typeof service & {
            resolveSnapshot?: (request: {
                cwd: string;
                anchor: { kind: 'line'; filePath: string; line: number };
            }) => Promise<typeof resolvedSnapshot | null>;
        };

        expect(typeof serviceWithResolver.resolveSnapshot).toBe('function');
        if (typeof serviceWithResolver.resolveSnapshot !== 'function') return;

        await expect(serviceWithResolver.resolveSnapshot({
            cwd: '/workspace',
            anchor: { kind: 'line', filePath: 'src/a.ts', line: 4 },
        })).resolves.toEqual(resolvedSnapshot);
        expect(resolveSnapshot).toHaveBeenCalledWith({
            cwd: '/workspace',
            anchor: { kind: 'line', filePath: 'src/a.ts', line: 4 },
        }, undefined);
    });

    it('fails closed when no host snapshot resolver is bound', async () => {
        const service = createPluginReviewCommentsService({ execute: vi.fn() });
        const serviceWithResolver = service as typeof service & {
            resolveSnapshot?: (request: {
                cwd: string;
                anchor: { kind: 'file'; filePath: string };
            }) => Promise<unknown>;
        };

        expect(typeof serviceWithResolver.resolveSnapshot).toBe('function');
        if (typeof serviceWithResolver.resolveSnapshot !== 'function') return;

        await expect(serviceWithResolver.resolveSnapshot({
            cwd: '/workspace',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
        })).resolves.toBeNull();
    });

    it('routes every plugin review-comment method through canonical action ids', async () => {
        const comment = {
            v: 1,
            id: 'comment-1',
            accountId: 'account-1',
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'a.ts' },
            snapshot: { kind: 'too_large', filePath: 'a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'body',
            bodyVersion: 1,
            edits: [],
            author: { kind: 'plugin', pluginId: 'review-coderabbit' },
            state: 'proposed',
            flags: {},
            dispositions: {},
            threadId: 'comment-1',
            transitions: [
                {
                    transitionId: 'transition-1',
                    toState: 'proposed',
                    transitionedAt: 1,
                    transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
                    serverRevision: 1,
                },
            ],
            createdAt: 1,
            updatedAt: 1,
            serverRevision: 1,
        };
        const execute = vi.fn(async (actionId: string) => {
            if (actionId === 'reviews.comments.list') return { items: [comment], cursor: null };
            if (actionId === 'reviews.comments.reply') return { comment, parent: comment };
            if (actionId === 'reviews.comments.bulkTransition') return { bulkActionId: 'bulk-1', updated: [comment], failed: [] };
            return { comment };
        });
        const service = createPluginReviewCommentsService({ execute });

        await service.create({ projectId: 'project-1', anchor: { kind: 'file', filePath: 'a.ts' }, snapshot: { kind: 'too_large', filePath: 'a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 }, body: 'body', clientMutationId: 'm1' });
        await service.list({ projectId: 'project-1' });
        await service.get({ commentId: 'comment-1' });
        await service.transition({ commentId: 'comment-1', toState: 'open', clientMutationId: 'm2' });
        await service.edit({ commentId: 'comment-1', nextBody: 'next', clientMutationId: 'm3' });
        await service.reply({ parentCommentId: 'comment-1', body: 'reply', clientMutationId: 'm4' });
        await service.redact({ commentId: 'comment-1', clientMutationId: 'm5' });
        await service.setDisposition({ commentId: 'comment-1', disposition: 'working', clientMutationId: 'm6' });
        await service.attachEvidence({ commentId: 'comment-1', evidence: [{ kind: 'reasoning', message: 'proof' }], clientMutationId: 'm7' });
        await service.bulkTransition({ commentIds: ['comment-1'], toState: 'open', clientMutationId: 'm8' });

        expect(execute.mock.calls.map(([actionId]) => actionId)).toEqual([
            'reviews.comments.create',
            'reviews.comments.list',
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

    it('sends plugin principal actor identity without trusted grant claims', async () => {
        const comment = {
            v: 1,
            id: 'comment-1',
            accountId: 'account-1',
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'a.ts' },
            snapshot: { kind: 'too_large', filePath: 'a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'body',
            bodyVersion: 1,
            edits: [],
            author: { kind: 'plugin', pluginId: 'review-coderabbit' },
            state: 'open',
            flags: {},
            dispositions: {},
            threadId: 'comment-1',
            transitions: [
                {
                    transitionId: 'transition-1',
                    toState: 'open',
                    transitionedAt: 1,
                    transitionedBy: { kind: 'plugin', pluginId: 'review-coderabbit' },
                    serverRevision: 1,
                },
            ],
            createdAt: 1,
            updatedAt: 1,
            serverRevision: 1,
        };
        const execute = vi.fn(async () => ({ comment }));
        const service = createPluginReviewCommentsService({
            execute,
            principalActor: { kind: 'plugin', pluginId: 'review-coderabbit' },
        });

        await service.create({
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'a.ts' },
            snapshot: { kind: 'too_large', filePath: 'a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'body',
            authorIntent: 'open',
            clientMutationId: 'm1',
        });

        expect(execute).toHaveBeenCalledWith(
            'reviews.comments.create',
            expect.objectContaining({ authorIntent: 'open' }),
            expect.objectContaining({
                principal: {
                    actor: { kind: 'plugin', pluginId: 'review-coderabbit' },
                    grants: [],
                },
            }),
        );
    });
});
