import { describe, expect, it } from 'vitest';

import { buildReviewCommentsOutboundMessage } from './buildReviewCommentsOutboundMessage';

const draft = {
    id: 'draft-1',
    filePath: 'src/a.ts',
    source: 'diff' as const,
    anchor: {
        kind: 'diffLine' as const,
        startLine: 1,
        side: 'after' as const,
        oldLine: 1,
        newLine: 1,
    },
    snapshot: {
        selectedLines: ['+export const a = 2;'],
        beforeContext: ['-export const a = 1;'],
        afterContext: [],
    },
    body: 'Please verify this project change.',
    createdAt: 1,
};

describe('buildReviewCommentsOutboundMessage', () => {
    it('preserves attachment metadata alongside review comment metadata', () => {
        const outbound = buildReviewCommentsOutboundMessage({
            sessionId: 'session-1',
            drafts: [draft],
            additionalMessage: '[attachments block]',
            displayTextSuffix: '[attachments block]',
            metaOverrides: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [{
                            name: 'note.txt',
                            path: '.happier/uploads/note.txt',
                            mimeType: 'text/plain',
                            sizeBytes: 12,
                            sha256: 'sha-note',
                        }],
                    },
                },
            },
        });

        expect(outbound.metaOverrides).toMatchObject({
            happier: {
                kind: 'review_comments.v1',
                payload: {
                    sessionId: 'session-1',
                    comments: [expect.objectContaining({ id: 'draft-1' })],
                },
            },
            happierAttachments: {
                kind: 'attachments.v1',
                payload: {
                    attachments: [expect.objectContaining({
                        name: 'note.txt',
                        path: '.happier/uploads/note.txt',
                    })],
                },
            },
        });
    });

    it('excludes blank review comment bodies from outbound prompt and metadata', () => {
        const outbound = buildReviewCommentsOutboundMessage({
            sessionId: 'session-1',
            drafts: [
                draft,
                {
                    ...draft,
                    id: 'draft-blank',
                    filePath: 'src/b.ts',
                    body: '   ',
                },
                {
                    ...draft,
                    id: 'draft-trimmed',
                    filePath: 'src/c.ts',
                    body: '  Keep this  ',
                },
            ],
            additionalMessage: '',
        });

        expect(outbound.text).not.toContain('src/b.ts');
        expect(outbound.text).toContain('Keep this');
        expect(outbound.text).not.toContain('  Keep this  ');
        expect(outbound.metaOverrides).toMatchObject({
            happier: {
                kind: 'review_comments.v1',
                payload: {
                    comments: [
                        expect.objectContaining({ id: 'draft-1', body: 'Please verify this project change.' }),
                        expect.objectContaining({ id: 'draft-trimmed', body: 'Keep this' }),
                    ],
                },
            },
        });
        const comments = ((outbound.metaOverrides.happier as { payload: { comments: Array<{ id: string }> } }).payload.comments);
        expect(comments.map((comment) => comment.id)).not.toContain('draft-blank');
    });
});
