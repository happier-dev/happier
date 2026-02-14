import { describe, expect, it } from 'vitest';

import { buildReviewCommentsDisplayText, buildReviewCommentsPromptText } from './reviewCommentPrompt';
import type { ReviewCommentDraft } from './reviewCommentTypes';

describe('reviewCommentPrompt', () => {
    it('builds a prompt block that is usable with no additional user message', () => {
        const drafts: ReviewCommentDraft[] = [
            {
                id: 'c1',
                filePath: 'src/a.ts',
                source: 'diff',
                anchor: { kind: 'diffLine', side: 'after', oldLine: null, newLine: 42, startLine: 10 },
                snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
                body: 'Please rename x to count',
                createdAt: 1,
            },
        ];

        const prompt = buildReviewCommentsPromptText({
            sessionId: 's1',
            drafts,
            additionalMessage: '',
        });

        expect(prompt).toContain('Review comments');
        expect(prompt).toContain('src/a.ts');
        expect(prompt).toContain('after');
        expect(prompt).toContain('42');
        expect(prompt).toContain('Please rename x to count');
        expect(prompt).toContain('const x = 1;');
    });

    it('builds a compact display text summary', () => {
        const drafts: ReviewCommentDraft[] = [
            {
                id: 'c1',
                filePath: 'src/a.ts',
                source: 'file',
                anchor: { kind: 'fileLine', startLine: 1 },
                snapshot: { selectedLines: ['hi'], beforeContext: [], afterContext: [] },
                body: 'nit',
                createdAt: 1,
            },
            {
                id: 'c2',
                filePath: 'src/b.ts',
                source: 'file',
                anchor: { kind: 'fileLine', startLine: 2 },
                snapshot: { selectedLines: ['bye'], beforeContext: [], afterContext: [] },
                body: 'nit2',
                createdAt: 2,
            },
        ];

        expect(buildReviewCommentsDisplayText({ drafts })).toContain('Review comments');
        expect(buildReviewCommentsDisplayText({ drafts })).toContain('2');
    });
});

