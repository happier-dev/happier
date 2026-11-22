import { describe, expect, it } from 'vitest';
import type { Tx } from '@/storage/inTx';
import { resolveReviewAccessInTx } from './reviewAccess';
import { readAdmittedReviewDetailInTx } from './reviewListService';
import { readAdmittedReviewHumanStateInTx } from './reviewHumanService';

describe('composed admitted Review read', () => {
    it('reads each shared Review fact once from admission through detail and attention', async () => {
        let groupedQueries = 0;
        let metadataQueries = 0;
        let artifactQueries = 0;
        const artifact = {
            id: 'review', kind: null, accountId: 'owner', account: { encryptionMode: 'plain' },
            createdAt: new Date(1), updatedAt: new Date(2),
            grants: [{ id: 'grant', principalKind: 'account', accountId: 'person', teamId: null, teamGroupId: null,
                accessLevel: 'edit', account: { status: 'active' }, team: null, teamGroup: null }],
        };
        const metadata = { artifactId: 'review', subjectKind: 'repository', sourceKind: 'direct',
            state: 'completed', currentRoundOrdinal: 2, projectSourceId: null, workflowId: null,
            startedAt: new Date(1), finishedAt: new Date(2) };
        // Prisma is the persistent boundary. A selected metadata relation reads the same stored facts.
        const tx = {
            artifact: {
                findMany: async () => { artifactQueries++; return [artifact]; },
                findUnique: async ({ select }: { select: { reviewMetadata?: boolean } }) => {
                    artifactQueries++;
                    if (select.reviewMetadata) {
                        metadataQueries++;
                        return { ...artifact, reviewMetadata: metadata };
                    }
                    return artifact;
                },
            },
            reviewMetadata: {
                findUnique: async () => { metadataQueries++; return metadata; },
                findMany: async () => { metadataQueries++; return [metadata]; },
            },
            reviewRequestedReviewer: { findMany: async () => [] },
            reviewVerdict: { findMany: async () => [] },
            $queryRaw: async () => { groupedQueries++; return [{ reviewId: 'review', total: 51, needsDecision: 1 }]; },
        } as unknown as Tx;
        const access = await resolveReviewAccessInTx(tx, { actorAccountId: 'person', reviewId: 'review', includeDetail: true });
        if (!access) throw new Error('Expected shared Review access');
        expect(access).toMatchObject({ ownerAccountId: 'owner', level: 'edit' });
        const review = await readAdmittedReviewDetailInTx(tx, access);
        const input = { actorAccountId: 'person', access,
            facts: { currentRoundOrdinal: review.currentRoundOrdinal, pendingDecisionCount: review.counts.needsDecision } };
        const human = await readAdmittedReviewHumanStateInTx(tx, input);
        expect(review).toMatchObject({ reviewId: 'review', currentRoundOrdinal: 2, createdAt: 1, updatedAt: 2 });
        expect(review.counts).toEqual({ total: 51, needsDecision: 1 });
        expect(human.needsYou).toMatchObject({ roundOrdinal: 2, pendingDecisions: true, needsYou: true });
        expect({ artifactQueries, metadataQueries, groupedQueries }).toEqual({ artifactQueries: 1, metadataQueries: 1, groupedQueries: 1 });
    });
});
