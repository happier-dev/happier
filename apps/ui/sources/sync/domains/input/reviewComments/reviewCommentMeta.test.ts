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
                anchor: { kind: 'fileLine', startLine: 1 },
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
    });

    it('parses valid payload and rejects invalid payload', () => {
        expect(parseReviewCommentsV1({ sessionId: 's1', comments: [] })).not.toBeNull();
        expect(parseReviewCommentsV1({ sessionId: 123 })).toBeNull();
    });
});

