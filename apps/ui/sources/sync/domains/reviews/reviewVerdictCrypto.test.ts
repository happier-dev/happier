import { describe, expect, it } from 'vitest';
import { openReviewVerdictContentV1, prepareReviewVerdictTransportInputV1, type ReviewHumanStateV1 } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';

describe('Review verdict prose at the client transport boundary', () => {
    it('uses the Review key and binds the authenticated person and persisted revision', async () => {
        const review = new ArtifactEncryption(new Uint8Array(32).fill(7));
        const otherAccount = new ArtifactEncryption(new Uint8Array(32).fill(9));
        const state: ReviewHumanStateV1 = { reviewId: 'review', roundOrdinal: 2, requests: [],
            verdicts: [{ accountId: 'person', roundOrdinal: 2, verdict: 'comment', revision: 3, submittedAt: 1 }],
            needsYou: { reviewId: 'review', roundOrdinal: 2, reason: 'review_needs_you', needsYou: true,
                requestedVerdict: true, pendingDecisions: false, canSubmitVerdict: true } };
        const transport = await prepareReviewVerdictTransportInputV1({ reviewId: 'review', roundOrdinal: 2,
            verdict: 'approve', body: 'Private reviewer prose' }, { accountId: 'person', state,
            seal: async value => ({ t: 'encrypted', c: await review.encryptHeader(value) }),
        });
        expect(transport).toMatchObject({ expectedRevision: 3, content: { t: 'encrypted' } });
        expect(JSON.stringify(transport)).not.toContain('Private reviewer prose');
        if (transport.content?.t !== 'encrypted') throw new Error('Expected a sealed verdict');
        expect(await otherAccount.decryptHeaderRaw(transport.content.c)).toBeNull();
        await expect(openReviewVerdictContentV1({ content: transport.content,
            expected: { reviewId: 'review', roundOrdinal: 2, accountId: 'person', revision: 4 },
            open: async content => content.t === 'encrypted' ? review.decryptHeaderRaw(content.c) : content.v,
        })).resolves.toEqual({ reviewId: 'review', roundOrdinal: 2, accountId: 'person', revision: 4, body: 'Private reviewer prose' });
    });
});
