import { describe, expect, it } from 'vitest';
import { buildReviewCommentsOutboundMessage as buildCanonicalReviewCommentsOutboundMessage} from '@happier-dev/protocol/messages/structured/reviewCommentsInput';
import { withParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';

import { buildReviewCommentsOutboundMessage } from './buildReviewCommentsOutboundMessage';
import { buildAskSelectionDrafts } from '@/components/ui/code/selection/askSelectionModel';
import { ReviewCommentsMessageMetaV1Schema } from '@happier-dev/protocol/messages/structured/reviewCommentsV1';

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
    it('retains an anchored Ask quote with no comment body in the actual outbound envelope', () => {
        const drafts = buildAskSelectionDrafts({ filePath: 'src/a.ts', source: 'file', text: 'selected code', savedText: 'selected code',
            ranges: [{ startLine: 1, endLine: 1, text: 'selected code' }] });
        const outbound = buildReviewCommentsOutboundMessage({ sessionId: 'session-1', drafts, additionalMessage: 'Why is this needed?' });
        const envelope = ReviewCommentsMessageMetaV1Schema.parse(outbound.metaOverrides.happier);
        expect(envelope.payload.comments).toMatchObject([{ body: '', includeInPrompt: true,
            anchor: { kind: 'range', startLine: 1, endLine: 1 }, snapshot: { selectedLines: ['selected code'] } }]);
        expect(outbound.text).toContain('selected code');
        expect(outbound.text).toContain('Why is this needed?');
    });
    it('materializes the same exact review input for the host Action and canonical Run recipient', () => {
        const params = { sessionId: 'session-1', drafts: [draft, { ...draft, id: 'detached', includeInPrompt: false }],
            additionalMessage: 'Saved stop explanation at revision 3' };
        const canonical = buildCanonicalReviewCommentsOutboundMessage(params);
        expect(canonical).toEqual(buildReviewCommentsOutboundMessage(params));
        expect(canonical.text).toContain(draft.snapshot.selectedLines[0]);
        expect(canonical.text).toContain(params.additionalMessage);
        expect(withParticipantRecipientV1(canonical.metaOverrides, { kind: 'execution_run', runId: 'writer' })).toMatchObject({
            happier: { kind: 'review_comments.v1', payload: { comments: [expect.objectContaining({ id: draft.id })] } },
        });
        const whitespace = buildCanonicalReviewCommentsOutboundMessage({ ...params,
            drafts: [{ ...draft, body: '  Keep this question.  ' }] });
        expect(whitespace.metaOverrides).toMatchObject({
            happier: { payload: { comments: [{ body: 'Keep this question.' }] } },
        });
        expect(whitespace.text).toContain('  Keep this question.  ');
    });
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
        expect(outbound.text).toContain('reviews.comments.transition');
        expect(outbound.text).toContain('reviews.comments.setDisposition');
        expect(outbound.text).toContain('Please verify this project change.');
        expect(outbound.text).toContain('[attachments block]');
    });
});
