import { describe, expect, it } from 'vitest';
import type { Tx } from '@/storage/inTx';
import { readAdmittedReviewNeedsYouInTx } from './reviewHumanService';

describe('admitted Review attention inventory', () => {
    it('reads human facts as a batch and keeps renewed, submitted and unrequested Reviews separate', async () => {
        const reads: string[] = [];
        const metadata = ['renewed', 'submitted', 'findings'].map(artifactId => ({ artifactId, currentRoundOrdinal: 2 }));
        const requests = ['renewed', 'submitted'].map(reviewId => ({ reviewId, id: reviewId, roundOrdinal: 2,
            principal: { kind: 'account', accountId: 'person' }, required: true,
            eligibleAccounts: [{ accountId: 'person' }] }));
        const verdicts = [{ reviewId: 'submitted', accountId: 'person', roundOrdinal: 2, verdict: 'approve',
            content: null, revision: 1, submittedAt: new Date(2) }];
        type Where = { reviewId?: string | { in: readonly string[] }; artifactId?: string | { in: readonly string[] }; OR?: readonly Where[] };
        const matches = (where: Where, id: string): boolean => {
            if (where.OR) return where.OR.some(arm => matches(arm, id));
            const selected = where.reviewId ?? where.artifactId;
            return typeof selected === 'string' ? selected === id : selected?.in.includes(id) === true;
        };
        // Prisma is the persistent database boundary. Keep all Review projection
        // logic real, and record query shape rather than mocking the human owner.
        const tx = {
            artifact: { findMany: async () => {
                reads.push('audiences');
                return requests.map(row => ({ id: row.reviewId, kind: 'v1:other:review.v1', accountId: 'owner',
                    account: { encryptionMode: 'plain' }, grants: [{ principalKind: 'account', accountId: 'person',
                        teamId: null, teamGroupId: null, accessLevel: 'edit', account: { status: 'active' } }] }));
            } },
            reviewMetadata: {
                findUnique: async ({ where }: { where: { artifactId: string } }) => {
                    reads.push('metadata'); return metadata.find(row => row.artifactId === where.artifactId);
                },
                findMany: async ({ where }: { where: { artifactId: { in: readonly string[] } } }) => {
                    reads.push('metadata'); return metadata.filter(row => matches(where, row.artifactId));
                },
            },
            reviewRequestedReviewer: { findMany: async ({ where }: { where: { reviewId: string | { in: readonly string[] } } }) => {
                reads.push('requests'); return requests.filter(row => matches(where, row.reviewId));
            } },
            reviewVerdict: { findMany: async ({ where }: { where: { reviewId: string | { in: readonly string[] } } }) => {
                reads.push('verdicts'); return verdicts.filter(row => matches(where, row.reviewId));
            } },
            $queryRaw: async () => { reads.push('counts'); return [{ reviewId: 'findings', total: 1, needsDecision: 1 }]; },
        } as unknown as Tx;
        const result = await readAdmittedReviewNeedsYouInTx(tx, { actorAccountId: 'person',
            reviews: metadata.map(row => ({ reviewId: row.artifactId, ownerAccountId: 'owner', level: 'edit', encryptionMode: 'plain' })) });
        expect([...result.values()]).toMatchObject([
            { reviewId: 'renewed', roundOrdinal: 2, requestedVerdict: true, pendingDecisions: false, needsYou: true },
            { reviewId: 'submitted', requestedVerdict: false, pendingDecisions: false, needsYou: false },
            { reviewId: 'findings', requestedVerdict: false, pendingDecisions: true, needsYou: true },
        ]);
        expect(reads.sort()).toEqual(['counts', 'metadata', 'requests', 'verdicts']);
    });
});
