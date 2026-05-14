import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceAnchorsResolveResponseV1 } from '@happier-dev/protocol';

import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';

import { resolveReviewCommentDraftAnchorsForPrompt } from './resolveReviewCommentDraftAnchorsForPrompt';

const draft: ReviewCommentDraft = {
    id: 'draft-1',
    filePath: 'src/a.ts',
    source: 'file',
    anchor: {
        kind: 'line',
        filePath: 'src/a.ts',
        line: 4,
        lineHash: 'lh1:1234567890abcdef',
    },
    snapshot: {
        selectedLines: ['const original = true;'],
        beforeContext: [],
        afterContext: [],
    },
    body: 'Review this',
    createdAt: 1,
};

describe('resolveReviewCommentDraftAnchorsForPrompt', () => {
    it('attaches per-draft daemon resolutions without mutating stored drafts', async () => {
        const resolveAnchors = vi.fn(async (): Promise<WorkspaceAnchorsResolveResponseV1> => ({
            success: true as const,
            resolutions: [{
                id: 'draft-1',
                filePath: 'src/a.ts',
                originalAnchor: draft.anchor,
                resolvedAnchor: {
                    kind: 'line' as const,
                    filePath: 'src/a.ts',
                    line: 8,
                    lineHash: 'lh1:fedcba0987654321' as const,
                },
                status: 'hash' as const,
                confidence: 0.85,
            }],
        }));

        const resolved = await resolveReviewCommentDraftAnchorsForPrompt({
            drafts: [draft],
            reviewScope: {
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/repo',
            },
            resolveAnchors,
        });

        expect(resolveAnchors).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'server-1',
            machineId: 'machine-1',
            workspacePath: '/repo',
            comments: [expect.objectContaining({
                id: 'draft-1',
                filePath: 'src/a.ts',
                source: 'file',
                anchor: draft.anchor,
                snapshot: draft.snapshot,
            })],
        }));
        expect(resolved[0]).not.toBe(draft);
        expect(resolved[0]?.anchor).toEqual(draft.anchor);
        expect(resolved[0]?.anchorResolution).toMatchObject({
            status: 'hash',
            resolvedAnchor: { kind: 'line', line: 8 },
        });
        expect(draft.anchorResolution).toBeUndefined();
    });

    it('fails closed to the original drafts when the resolver is unavailable', async () => {
        const resolved = await resolveReviewCommentDraftAnchorsForPrompt({
            drafts: [draft],
            reviewScope: null,
            resolveAnchors: vi.fn(),
        });

        expect(resolved).toEqual([draft]);
    });
});
