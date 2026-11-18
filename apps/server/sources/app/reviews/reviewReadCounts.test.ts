import { describe, expect, it } from 'vitest';
import type { Tx } from '@/storage/inTx';
import { readAdmittedReviewDetailInTx } from './reviewListService';
import { readAdmittedReviewHumanStateInTx } from './reviewHumanService';

describe('composed admitted Review read', () => {
    it('uses one grouped finding query for detail and requested-person attention', async () => {
        let groupedQueries = 0;
        let metadataQueries = 0;
        // Prisma is the persistent boundary; both real read owners consume these rows.
        const tx = {
            artifact: { findUnique: async () => ({ createdAt: new Date(1), updatedAt: new Date(2),
                reviewMetadata: { artifactId: 'review', subjectKind: 'repository', sourceKind: 'direct',
                    state: 'completed', currentRoundOrdinal: 2, projectSourceId: null, workflowId: null,
                    startedAt: new Date(1), finishedAt: new Date(2) } }) },
            reviewMetadata: { findMany: async () => { metadataQueries++; return [{ artifactId: 'review', currentRoundOrdinal: 2 }]; } },
            reviewRequestedReviewer: { findMany: async () => [] },
            reviewVerdict: { findMany: async () => [] },
            $queryRaw: async () => { groupedQueries++; return [{ reviewId: 'review', total: 51, needsDecision: 1 }]; },
        } as unknown as Tx;
        const access = { reviewId: 'review', ownerAccountId: 'person', level: 'owner', encryptionMode: 'plain' } as const;
        const review = await readAdmittedReviewDetailInTx(tx, access.reviewId);
        if (!review) throw new Error('Expected admitted Review');
        const input = { actorAccountId: 'person', access,
            facts: { currentRoundOrdinal: review.currentRoundOrdinal, pendingDecisionCount: review.counts.needsDecision } };
        const human = await readAdmittedReviewHumanStateInTx(tx, input);
        expect(review.counts).toEqual({ total: 51, needsDecision: 1 });
        expect(human.needsYou).toMatchObject({ roundOrdinal: 2, pendingDecisions: true, needsYou: true });
        expect(groupedQueries).toBe(1);
        expect(metadataQueries).toBe(0);
    });
});
