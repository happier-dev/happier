import { describe, expect, it } from 'vitest';

import { ReviewCommentsV1Schema, buildReviewCommentsV1MetaPayload, parseReviewCommentsV1 } from './reviewCommentMeta';
import type { ReviewCommentDraft } from './reviewCommentTypes';

describe('reviewCommentMeta', () => {
    it('builds a v1 payload from drafts', () => {
        const drafts: ReviewCommentDraft[] = [
            {
                id: 'c1',
                filePath: 'src/a.ts',
                source: 'file',
                anchor: { kind: 'fileLine', startLine: 1, lineHash: 'lh1:1234567890abcdef' },
                snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                body: 'nit',
                createdAt: 1,
            },
        ];

        const payload = buildReviewCommentsV1MetaPayload({ sessionId: 's1', drafts });
        const parsed = ReviewCommentsV1Schema.parse(payload);
        expect(parsed.sessionId).toBe('s1');
        expect(parsed.comments).toHaveLength(1);
        expect(parsed.comments[0].filePath).toBe('src/a.ts');
        expect(parsed.comments[0].anchor).toMatchObject({ lineHash: 'lh1:1234567890abcdef' });
    });

    it('drops blank review comment bodies and trims stored comment text', () => {
        const drafts: ReviewCommentDraft[] = [
            {
                id: 'c1',
                filePath: 'src/a.ts',
                source: 'file',
                anchor: { kind: 'fileLine', startLine: 1 },
                snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                body: '  nit  ',
                createdAt: 1,
            },
            {
                id: 'c2',
                filePath: 'src/b.ts',
                source: 'file',
                anchor: { kind: 'fileLine', startLine: 2 },
                snapshot: { selectedLines: ['y'], beforeContext: [], afterContext: [] },
                body: '   ',
                createdAt: 2,
            },
        ];

        const payload = buildReviewCommentsV1MetaPayload({ sessionId: 's1', drafts });

        expect(payload.comments).toEqual([
            expect.objectContaining({
                id: 'c1',
                body: 'nit',
            }),
        ]);
    });

    it('parses valid payload and rejects invalid payload', () => {
        expect(parseReviewCommentsV1({ sessionId: 's1', comments: [] })).not.toBeNull();
        expect(parseReviewCommentsV1({
            sessionId: 's1',
            comments: [{
                id: 'c1',
                filePath: 'src/a.ts',
                source: 'file',
                anchor: { kind: 'fileLine', startLine: 1 },
                snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                body: 'nit',
                createdAt: 1,
            }],
        })).not.toBeNull();
        expect(parseReviewCommentsV1({ sessionId: 123 })).toBeNull();
        expect(parseReviewCommentsV1({
            sessionId: 's1',
            comments: [{
                id: 'c1',
                filePath: 'src/a.ts',
                source: 'file',
                anchor: { kind: 'fileLine', startLine: 1, lineHash: 'not-a-line-hash' },
                snapshot: { selectedLines: ['x'], beforeContext: [], afterContext: [] },
                body: 'nit',
                createdAt: 1,
            }],
        })).toBeNull();
    });
});
